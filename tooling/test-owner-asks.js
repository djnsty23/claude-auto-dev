#!/usr/bin/env node
'use strict';
// test-owner-asks.js - receipted asks, complete visibility, measured owner time.
//
// Subjects: plugins/autodev-core/scripts/owner-asks.js, and the two places it is
// wired: fleet-notify.js (raises an ask, records os-submitted after a toast) and
// fleet-view.js (lists every source with its state, records the owner's answer).
//
// Four claims, each with a control that proves the probe can see the other side:
//   unchanged_asks          an unchanged ask rewritten with a new mtime, and the
//                           same ask re-raised by a rerun, is ONE ask and one toast.
//                           Control: a changed question is a second ask.
//   delivery_without_receipt  a notifier that returned exit 0 leaves delivery
//                           UNKNOWN. Control: the owner's ack reads DELIVERED.
//   stale_source            a notifier marker two hours old is a STALE line in
//                           fleet-view's list, and Windows notification history is
//                           an INACCESSIBLE line. Control: a fresh marker reads ok.
//   authority_from_silence  an ask with a past deadline and a default grants no
//                           authority. Control: the owner's answer does.
//
// No real notification is sent: every fleet-notify pass runs through a driver
// that installs the setNotifier seam, and the seam spawns `node -e` exiting 0 as
// the stand-in for powershell's exit 0. Fixtures live in a temp dir only, and the
// real ~/.claude owner-asks ledger and notifier files are asserted unchanged.
//
// Prints one `ok ` or `BAD` line per check, then the acceptance line last.
// Run: node tooling/test-owner-asks.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts');
const NOTIFY = path.join(SCRIPTS, 'fleet-notify.js');
const VIEW = path.join(SCRIPTS, 'fleet-view.js');
const OWNER_CLI = path.join(SCRIPTS, 'owner-asks.js');
const OWNER = require(OWNER_CLI);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-asks-'));
const REAL = path.join(os.homedir(), '.claude');
const REAL_FILES = [path.join(REAL, 'autodev', 'owner-asks', 'ledger.jsonl'), path.join(REAL, 'fleet', '.notified.json'), path.join(REAL, 'fleet', '.notify-last-run.json')];
const snap = (f) => { try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return 'absent'; } };
const realBefore = REAL_FILES.map(snap);

let bad = 0;
let total = 0;
function check(name, cond, detail) {
    total++;
    if (cond) console.log(`ok  ${name}`);
    else { bad++; console.log(`BAD ${name}${detail ? ` :: ${String(detail).slice(0, 600)}` : ''}`); }
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

// ------------------------------------------------------------------ fixtures
function makeHome(name) {
    const home = path.join(ROOT, name);
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'proj'), { recursive: true });
    fs.mkdirSync(path.join(home, 'appdata', 'Claude', 'claude-code-sessions'), { recursive: true });
    return home;
}
const autodev = (home) => path.join(home, '.claude', 'autodev');
const stateFile = (home) => path.join(home, 'state', '.notified.json');
const markerFile = (home) => path.join(home, 'state', '.notify-last-run.json');
const ledgerOf = (home) => OWNER.ledgerPath(autodev(home));

function runAsk(home, job, stamp, q) {
    const dir = path.join(autodev(home), 'runs', job, stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ job, cwd: '/fixture/project', state: 'running', started: minutesAgo(5) }) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'ask.json'), JSON.stringify(q) + '\n', 'utf8');
    return path.join(dir, 'ask.json');
}

function envFor(home, extra = {}) {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^AUTODEV_FLEET_DIR$/i.test(k)) delete env[k];
    return Object.assign(env, {
        HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
        AUTODEV_FLEET_STATE: stateFile(home), AUTODEV_QUOTA_TRIPWIRE: 'off',
        AUTODEV_QUOTA_STATE: path.join(home, 'state', 'quota.json'), AUTODEV_FLEET_CONFIG_DIRS: '',
    }, extra);
}

// The driver installs the notifier seam in every mode, so the shipped toast()
// that reaches powershell is never called. 'exit0' spawns a child that exits 0,
// the same fact the real notifier hands back. 'throw' is a toast the OS refused.
const DRIVER = path.join(ROOT, 'drive.js');
fs.writeFileSync(DRIVER, [
    "'use strict';",
    "const { spawnSync } = require('node:child_process');",
    'const [subject, mode] = process.argv.slice(2);',
    'const n = require(subject);',
    'n.setNotifier((title, body) => {',
    "    const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);",
    "    console.log('TOAST|' + title + '|' + body + '|exit=' + r.status);",
    "    if (mode === 'throw') throw new Error('refused by the OS (fixture)');",
    '});',
    "console.log('FIRED ' + n.pass());",
].join('\n') + '\n', 'utf8');
const drive = (home, mode = 'exit0') => spawnSync(process.execPath, [DRIVER, NOTIFY, mode], { encoding: 'utf8', env: envFor(home), windowsHide: true, timeout: 60000 });
const firedIn = (r) => { const m = String(r.stdout || '').match(/^FIRED (\d+)$/m); return m ? Number(m[1]) : NaN; };
const toastsIn = (r) => String(r.stdout || '').split('\n').filter((l) => l.startsWith('TOAST|'));
const sumOf = (home) => OWNER.summarise(OWNER.readLedger(ledgerOf(home)).events);
const brief = (r) => `exit=${r.status} out=${JSON.stringify(String(r.stdout || '').slice(0, 400))} err=${JSON.stringify(String(r.stderr || '').slice(0, 300))}`;

const viewList = (home, extraEnv = {}) => spawnSync(process.execPath, [VIEW, 'list', '--home', home, '--appdata', path.join(home, 'appdata')],
    { encoding: 'utf8', env: envFor(home, extraEnv), windowsHide: true, timeout: 60000 });
const ownerCli = (home, args) => spawnSync(process.execPath, [OWNER_CLI, ...args, '--home', home], { encoding: 'utf8', env: envFor(home), windowsHide: true, timeout: 30000 });

let unchangedAsks = 'unmeasured';
let deliveryWithoutReceipt = 'unmeasured';
let staleSource = 'unmeasured';
let authorityFromSilence = 'unmeasured';

try {
    // ============================================================ 1. identity
    const hId = makeHome('identity');
    const Q = { question: 'Seeded or production?', options: [{ label: 'Seeded (Recommended)' }, { label: 'Production' }] };
    const ask1 = runAsk(hId, 'job-seed', '2026-10-14T00-00-00-000Z', Q);
    const p1 = drive(hId);
    check('identity: the first pass toasts the ask once', p1.status === 0 && firedIn(p1) === 1, brief(p1));
    // The same content, rewritten later with a new mtime, as a worker re-saving its ask does.
    fs.writeFileSync(ask1, JSON.stringify({ options: Q.options, question: Q.question }, null, 2) + '\n', 'utf8');
    const later = new Date(Date.now() + 120000);
    fs.utimesSync(ask1, later, later);
    const p2 = drive(hId);
    check('identity: an unchanged ask rewritten with a new mtime does not toast again', p2.status === 0 && firedIn(p2) === 0, brief(p2));
    // A rerun of the job re-raises the same decision and input from a new ask.json.
    fs.rmSync(path.dirname(ask1), { recursive: true, force: true });
    runAsk(hId, 'job-seed', '2026-10-14T01-00-00-000Z', Q);
    const p3 = drive(hId);
    check('identity: a rerun re-raising the same ask from a new file is not re-sent', p3.status === 0 && firedIn(p3) === 0
        && /re-raised, not re-sent/.test(p3.stdout), brief(p3));
    const s1 = sumOf(hId);
    unchangedAsks = s1.asks.length;
    check('identity: the ledger holds one ask for the unchanged decision', s1.asks.length === 1, JSON.stringify(s1.asks.map((a) => [a.key, a.raises])));
    check('identity: the re-raise was counted as a raise of that one ask', s1.asks[0] && s1.asks[0].raises === 2, JSON.stringify(s1.asks));
    // In-process, five raises of one ask under five different mtimes.
    const f5 = path.join(ROOT, 'five', 'ask.json');
    fs.mkdirSync(path.dirname(f5), { recursive: true });
    const l5 = path.join(ROOT, 'five', 'ledger.jsonl');
    for (let i = 0; i < 5; i++) {
        fs.writeFileSync(f5, JSON.stringify(Q) + '\n', 'utf8');
        const t = new Date(Date.now() + i * 3600000);
        fs.utimesSync(f5, t, t);
        OWNER.raise(l5, OWNER.identityOfFile(f5, 'runs:five'), { ask: Q });
    }
    const s5 = OWNER.summarise(OWNER.readLedger(l5).events);
    check('identity: five raises under five mtimes are one ask with five raises', s5.asks.length === 1 && s5.asks[0].raises === 5, JSON.stringify(s5.asks.map((a) => [a.key, a.raises])));
    check('identity: key order inside ask.json does not change the input version',
        OWNER.askIdentity({ question: 'q', options: [{ label: 'a' }] }).key === OWNER.askIdentity({ options: [{ label: 'a' }], question: 'q' }).key);
    check('identity: a declared decision id is the decision', OWNER.askIdentity({ decision: 'D-7', question: 'q' }, { fallbackDecision: 'runs:x' }).decision === 'D-7');
    // Control: a changed question is a new input version and a new toast.
    runAsk(hId, 'job-seed', '2026-10-14T01-00-00-000Z', { ...Q, question: 'Seeded or production, now that main moved?' });
    const p4 = drive(hId);
    const s1b = sumOf(hId);
    check('identity control: a changed question is a second ask and toasts', firedIn(p4) === 1 && s1b.asks.length === 2
        && new Set(s1b.asks.map((a) => a.decision)).size === 1, `${brief(p4)} asks=${JSON.stringify(s1b.asks.map((a) => a.key))}`);

    // ============================================================ 2. delivery
    const hDel = makeHome('delivery');
    runAsk(hDel, 'job-del', '2026-10-14T00-00-00-000Z', { question: 'Which base?' });
    const d0 = drive(hDel, 'throw');
    const sq = sumOf(hDel);
    check('delivery: a toast the OS refused leaves the ask queued', firedIn(d0) === 0 && sq.asks.length === 1 && sq.asks[0].state === 'queued'
        && sq.asks[0].delivery === 'UNKNOWN', `${brief(d0)} ${JSON.stringify(sq.asks)}`);
    const d1 = drive(hDel, 'exit0');
    const sd = sumOf(hDel);
    const t1 = toastsIn(d1);
    check('delivery: the notifier ran and its child exited 0', firedIn(d1) === 1 && t1.length === 1 && t1[0].endsWith('|exit=0'), brief(d1));
    check('delivery: that ask is os-submitted, not receipted', sd.asks[0] && sd.asks[0].state === 'os-submitted', JSON.stringify(sd.asks));
    deliveryWithoutReceipt = sd.asks[0] ? sd.asks[0].delivery : 'missing';
    check('delivery: exit 0 without a receipt reads UNKNOWN', deliveryWithoutReceipt === 'UNKNOWN', JSON.stringify(sd.asks));
    const dl = viewList(hDel);
    check('delivery: fleet-view prints the UNKNOWN count', /owner-asks: 1 ask\(s\): queued 0, os-submitted 1, receipted 0, resolved 0; delivery UNKNOWN for 1 without a receipt/.test(dl.stdout), brief(dl));
    const ackBad = ownerCli(hDel, ['ack', '--key', 'nope@0000']);
    check('delivery: ack refuses a key the ledger does not hold', ackBad.status === 1 && /unknown-key/.test(ackBad.stderr), brief(ackBad));
    const ack = ownerCli(hDel, ['ack', '--key', sd.asks[0].key]);
    const sr = sumOf(hDel);
    check('delivery control: the owner\'s ack makes it receipted and DELIVERED', ack.status === 0 && sr.asks[0].state === 'receipted' && sr.asks[0].delivery === 'DELIVERED', `${brief(ack)} ${JSON.stringify(sr.asks)}`);
    // The owner's answer through fleet-view's own action is the resolution.
    process.env.AUTODEV_FLEET_STATE = stateFile(hDel);
    process.env.AUTODEV_FLEET_CONFIG_DIRS = '';
    const FV = require(VIEW);
    const sDel = FV.settings({ home: hDel, appdata: path.join(hDel, 'appdata'), events: path.join(hDel, 'events.jsonl') });
    const askRow = FV.collect(sDel).rows.find((r) => r.question);
    const out = askRow ? FV.doAction(sDel, 'answer', askRow.key, { label: 'main' }) : null;
    const sres = sumOf(hDel);
    check('delivery: answering in fleet-view resolves the same ask key', !!out && /resolved /.test(out.detail) && sres.asks.length === 1 && sres.asks[0].state === 'resolved',
        `${out && out.detail} ${JSON.stringify(sres.asks)}`);
    check('delivery: the four states are the documented order', JSON.stringify(OWNER.STATES) === JSON.stringify(['queued', 'os-submitted', 'receipted', 'resolved']));

    // ============================================================ 3. visibility
    const hVis = makeHome('visible');
    runAsk(hVis, 'job-vis', '2026-10-14T00-00-00-000Z', { question: 'Ship it?' });
    fs.mkdirSync(path.dirname(markerFile(hVis)), { recursive: true });
    const missing = viewList(hVis);
    check('visible: a notifier that never ran is an INACCESSIBLE line', /owner-asks source notifier: INACCESSIBLE \(.*never ran/.test(missing.stdout), brief(missing));
    fs.writeFileSync(markerFile(hVis), JSON.stringify({ at: minutesAgo(120), transcripts: 3, blocked: 0, asking: 1, fresh: 0, dry: false }) + '\n', 'utf8');
    const stale = viewList(hVis);
    const staleLine = stale.stdout.split('\n').find((l) => l.startsWith('owner-asks source notifier:')) || '';
    staleSource = /: STALE \(last pass (120m|2h) ago/.test(staleLine) ? 'VISIBLE' : 'MISSING';
    check('visible: a notifier marker 120 minutes old is a STALE line in the list', staleSource === 'VISIBLE', brief(stale));
    check('visible: the desktop panels it reads are STALE too', /owner-asks source desktop-panels: STALE \(3 transcript/.test(stale.stdout), brief(stale));
    check('visible: Windows notification history is listed as INACCESSIBLE, never left out',
        /owner-asks source windows-toast-history: INACCESSIBLE \((no supported adapter|not applicable on )/.test(stale.stdout), brief(stale));
    check('visible: the ask sources are listed beside the notifier', /owner-asks source asks:runs: ok/.test(stale.stdout) && /owner-asks source asks:headless-worker: INACCESSIBLE/.test(stale.stdout), brief(stale));
    const sVis = FV.settings({ home: hVis, appdata: path.join(hVis, 'appdata') });
    process.env.AUTODEV_FLEET_STATE = stateFile(hVis);
    const page = FV.renderPage(FV.collect(sVis), 'tok', null);
    check('visible: the page marks the stale source as a warning line', /<li class="warn">owner-asks source notifier: STALE/.test(page), page.slice(0, 200));
    fs.mkdirSync(ledgerOf(hVis), { recursive: true });
    const unread = viewList(hVis);
    check('visible: an unreadable owner-asks ledger is an INACCESSIBLE line', /owner-asks source owner-asks-ledger: INACCESSIBLE/.test(unread.stdout), brief(unread));
    fs.rmSync(ledgerOf(hVis), { recursive: true, force: true });
    fs.writeFileSync(markerFile(hVis), JSON.stringify({ at: minutesAgo(1), transcripts: 3, blocked: 0, asking: 1, fresh: 0, dry: false }) + '\n', 'utf8');
    const fresh = viewList(hVis);
    check('visible control: a fresh marker reads ok, so STALE is not constant', /owner-asks source notifier: ok \(last pass 1m ago/.test(fresh.stdout), brief(fresh));
    const multi = spawnSync(process.execPath, [VIEW, 'list', '--home', hVis, '--appdata', path.join(hVis, 'appdata'), '--config-dir', path.join(hVis, '.claude'), '--config-dir', path.join(ROOT, 'no such account')],
        { encoding: 'utf8', env: envFor(hVis, { AUTODEV_FLEET_STATE: '' }), windowsHide: true, timeout: 60000 });
    check('visible: an unreadable account still gets its own owner-asks lines', multi.status === 0
        && multi.stdout.includes(`[${path.join(ROOT, 'no such account')}] owner-asks source asks:config-dir: INACCESSIBLE`)
        && multi.stdout.includes(`[${path.join(ROOT, 'no such account')}] owner-asks source notifier: INACCESSIBLE`), brief(multi));

    // ============================================================ 4. silence
    const hSil = makeHome('silence');
    const silAsk = runAsk(hSil, 'job-sil', '2026-10-14T00-00-00-000Z',
        { question: 'Deploy to production?', options: [{ label: 'Yes' }, { label: 'No' }], default: 'Yes', deadline: minutesAgo(600), onTimeout: 'proceed' });
    const z1 = drive(hSil);
    const z2 = drive(hSil);
    const ss = sumOf(hSil);
    const entry = ss.asks[0];
    const g = entry ? OWNER.authority(entry) : null;
    check('silence: the ask was raised and its silence fields recorded as data', firedIn(z1) === 1 && firedIn(z2) === 0 && entry
        && entry.silenceFields && entry.silenceFields.default === 'Yes', `${brief(z1)} ${JSON.stringify(entry)}`);
    check('silence: ten hours past its deadline the fleet still waits', !!g && g.granted === false && g.action === 'wait', JSON.stringify(g));
    check('silence: nothing wrote an answer on the owner\'s behalf', !fs.existsSync(path.join(path.dirname(silAsk), 'answer.json')));
    const silAfs = OWNER.authorityFromSilence(ss);
    const zl = viewList(hSil);
    check('silence: fleet-view reports authority from silence 0', /authority from silence 0;/.test(zl.stdout), brief(zl));
    authorityFromSilence = silAfs + (fs.existsSync(path.join(path.dirname(silAsk), 'answer.json')) ? 1 : 0);
    check('silence: authority from silence counts 0', authorityFromSilence === 0, String(silAfs));
    OWNER.resolve(ledgerOf(hSil), entry.key, 'No', 'fixture owner answer');
    const g2 = OWNER.authority(sumOf(hSil).asks[0]);
    check('silence control: the owner\'s answer grants authority, and only its label', g2.granted === true && g2.from === 'owner-answer' && g2.label === 'No', JSON.stringify(g2));

    // ============================================================ 5. owner minutes
    const lm = path.join(ROOT, 'minutes', 'ledger.jsonl');
    fs.mkdirSync(path.dirname(lm), { recursive: true });
    const at = (hhmm) => `2026-10-14T${hhmm}:00.000Z`;
    const evs = [
        { at: at('10:00'), type: 'owner-time-start' },
        { at: at('10:25'), type: 'owner-time-stop' },
        { at: at('10:30'), type: 'raised', key: 'd@1', decision: 'd' },
        { at: at('11:30'), type: 'receipt', key: 'd@1', by: 'owner', how: 'ack' },
        { at: at('11:40'), type: 'owner-time-correct', minutes: -5, note: 'stepped away' },
        { at: at('12:00'), type: 'owner-time-start' },
    ];
    fs.writeFileSync(lm, evs.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const om = OWNER.ownerMinutes(OWNER.readLedger(lm).events);
    check('minutes: one start/stop pair minus a correction is 20 minutes', om.minutes === 20 && om.pairs === 1 && om.corrections === 1, JSON.stringify(om));
    check('minutes: a 60 minute acknowledgement latency adds nothing', om.minutes === 20, JSON.stringify(om));
    check('minutes: an open start is reported and not counted', om.open === at('12:00'), JSON.stringify(om));
    const hMin = makeHome('minutes-cli');
    const c1 = ownerCli(hMin, ['time', 'start', '--note', 'triage']);
    const c2 = ownerCli(hMin, ['time', 'stop']);
    const c3 = ownerCli(hMin, ['time', 'correct', '--minutes', '7', '--note', 'phone call not timed']);
    const c4 = ownerCli(hMin, ['time', 'correct', '--minutes', '3']);
    const omc = OWNER.ownerMinutes(OWNER.readLedger(ledgerOf(hMin)).events);
    check('minutes: the CLI records start, stop and a correction in the fixture ledger', c1.status === 0 && c2.status === 0 && c3.status === 0
        && omc.pairs === 1 && omc.corrections === 1 && omc.minutes >= 7 && omc.minutes < 8, `${brief(c1)} ${JSON.stringify(omc)}`);
    check('minutes: a correction with no reason is a usage error', c4.status === 2 && /needs --note/.test(c4.stderr), brief(c4));
    const st = ownerCli(hMin, ['status', '--json']);
    let sj = null; try { sj = JSON.parse(st.stdout); } catch { /* stays null */ }
    check('minutes: status --json carries the owner minutes and every source', !!sj && sj.ownerMinutes.minutes === omc.minutes
        && sj.sources.some((x) => x.source === 'windows-toast-history'), brief(st));

    // ============================================================ hermetic
    const writes = [ledgerOf(hId), ledgerOf(hDel), ledgerOf(hSil), ledgerOf(hMin), l5, lm];
    check('hermetic: every ledger this suite wrote is under its temp root', writes.every((f) => path.resolve(f).startsWith(path.resolve(ROOT) + path.sep) && fs.existsSync(f)), JSON.stringify(writes));
    const realAfter = REAL_FILES.map(snap);
    check('hermetic: the real ~/.claude owner-asks ledger and notifier files are unchanged', JSON.stringify(realBefore) === JSON.stringify(realAfter),
        `${JSON.stringify(realBefore)} -> ${JSON.stringify(realAfter)}`);
    check('hermetic: --help returns usage without touching a ledger', (() => { const r = spawnSync(process.execPath, [OWNER_CLI, '--help'], { encoding: 'utf8' }); return r.status === 0 && /Usage: node owner-asks.js/.test(r.stdout); })());
} catch (e) {
    check('the suite ran to the end', false, e.stack);
} finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp cleanup only */ }
}

console.log(`${total - bad}/${total} checks ok`);
if (bad) process.exitCode = 1;
console.log(`unchanged_asks=${unchangedAsks} delivery_without_receipt=${deliveryWithoutReceipt} stale_source=${staleSource} authority_from_silence=${authorityFromSilence}`);
