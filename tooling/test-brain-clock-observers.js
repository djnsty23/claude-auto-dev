#!/usr/bin/env node
'use strict';
// test-brain-clock-observers.js: drives brain-clock.js `tick --observe` with an observers.json
// in a fake ~/.claude, as a subprocess.
//
// The scorecard's release-window needs a daily live reading of GitHub's release protection, and
// the clock is the one scheduled process. This proves an observer runs once per interval and not
// every pass, that a failing one is an event and not a failed pass, that a bad config runs
// nothing, and that one pass runs at most one observer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '../plugins/autodev-core/scripts/brain-clock.js');
let ran = 0;
let failed = 0;
function check(name, cond, detail) {
    ran++;
    if (cond) { console.log(`ok ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(0, 600)}` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-clock-observers-'));
const claude = path.join(root, 'claude');
const autodev = path.join(claude, 'autodev');
const w = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
w(path.join(root, 'gh.json'), { open: {}, view: {} });
fs.mkdirSync(path.join(root, 'desktop'), { recursive: true });
const cfg = path.join(root, 'observers.json');
const env = { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude, BRAIN_CLOCK_DESKTOP_DIR: path.join(root, 'desktop'), BRAIN_CLOCK_ROLE_CHECKER: 'off',
    BRAIN_CLOCK_GH_FIXTURE: path.join(root, 'gh.json'), BRAIN_CLOCK_WORKER_RECONCILE: 'off', BRAIN_CLOCK_BRAIN_JUDGE: 'off', BRAIN_CLOCK_OBSERVERS: cfg };
function tick(at) {
    const r = spawnSync(process.execPath, [SUBJECT, 'tick', '--observe', '--now', at], { env, encoding: 'utf8' });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* reported */ }
    const line = json && Array.isArray(json.sources) ? json.sources.find((s) => /^observers: /.test(s)) : null;
    return { code: r.status, json, line, out: r.stdout + r.stderr };
}
const events = (type) => lines(path.join(autodev, 'events.jsonl')).map((l) => JSON.parse(l)).filter((e) => e.type === type);

// Two hand-written observers: one appends a row to its own ledger and exits 0, one exits 1.
const okLedger = path.join(root, 'ok-ledger.jsonl');
const okScript = path.join(root, 'ok-observer.js');
w(okScript, `require('fs').appendFileSync(${JSON.stringify(okLedger)}, JSON.stringify({ at: new Date().toISOString() }) + '\\n'); console.log('observed');\n`);
const badScript = path.join(root, 'bad-observer.js');
w(badScript, "console.log('github unreadable'); process.exitCode = 1;\n");

try {
    let t = tick('2026-11-01T06:00:00Z');
    check('no observers.json: the pass is ok and says none configured', t.code === 0 && t.json && t.json.ok && t.line === 'observers: none configured', t.out);

    w(cfg, { observers: [{ id: 'release', script: okScript, args: [], everyMin: 1440 }] });
    t = tick('2026-11-01T06:05:00Z');
    check('a due observer runs once and its ledger gains a row', t.code === 0 && /^observers: 1 configured, ran release exit 0 in \d+ ms$/.test(t.line || '') && lines(okLedger).length === 1, t.out);
    check('the run is one observer.ran event', events('observer.ran').length === 1 && events('observer.ran')[0].key === 'release' && events('observer.ran')[0].detail.exit === 0, JSON.stringify(events('observer.ran')));

    t = tick('2026-11-01T06:10:00Z');
    check('five minutes later it is not due and does not run', t.line === 'observers: 1 configured, none due' && lines(okLedger).length === 1, t.out);
    t = tick('2026-11-02T06:04:00Z');
    check('one minute short of its interval it still does not run', t.line === 'observers: 1 configured, none due' && lines(okLedger).length === 1, t.out);
    t = tick('2026-11-02T06:05:00Z');
    check('at its interval it runs again', /ran release exit 0/.test(t.line || '') && lines(okLedger).length === 2, t.out);

    w(cfg, { observers: [{ id: 'release', script: okScript, everyMin: 1440 }, { id: 'broken', script: badScript, everyMin: 60 }] });
    t = tick('2026-11-02T06:10:00Z');
    check('a failing observer is an observer.failed event, and the pass still succeeds', t.code === 0 && t.json.ok && /ran broken exit 1/.test(t.line || '')
        && events('observer.failed').length === 1 && events('observer.failed')[0].detail.last === 'github unreadable', t.out);

    w(cfg, { observers: [{ id: 'a', script: okScript, everyMin: 60 }, { id: 'b', script: okScript, everyMin: 60 }] });
    const before = lines(okLedger).length;
    t = tick('2026-11-03T00:00:00Z');
    check('two due observers: one pass runs exactly one', lines(okLedger).length === before + 1 && /ran [ab] exit 0/.test(t.line || ''), t.out);
    t = tick('2026-11-03T00:05:00Z');
    check('the next pass runs the other', lines(okLedger).length === before + 2, t.out);

    w(cfg, { observers: [{ id: 'fast', script: okScript, everyMin: 5 }] });
    const n0 = lines(okLedger).length;
    t = tick('2026-11-04T00:00:00Z');
    check('an interval under 60 minutes is CONFIG-INVALID and runs nothing', t.code === 0 && /^observers: CONFIG-INVALID fast: everyMin must be at least 60$/.test(t.line || '') && lines(okLedger).length === n0, t.out);
    t = tick('2026-11-04T00:05:00Z');
    check('the same bad config is one observer.config-invalid event, not one per pass', events('observer.config-invalid').length === 1, JSON.stringify(events('observer.config-invalid')));
    // A relative path with a directory in it is refused, the same as before bare names existed.
    for (const [i, rel] of ['sub/relative.js', '../relative.js', './relative.js'].entries()) {
        w(cfg, { observers: [{ id: 'rel', script: rel, everyMin: 60 }] });
        t = tick(`2026-11-04T00:1${i}:00Z`);
        check(`a relative script path ${rel} is refused`, /CONFIG-INVALID rel: script must be an absolute \.js path or a bare name/.test(t.line || ''), t.out);
    }

    // A bare name resolves beside the clock: an unshipped one names the clock's own directory, and
    // a shipped one runs from there, so observers.json survives a version bump.
    const clockDir = path.dirname(SUBJECT);
    w(cfg, { observers: [{ id: 'ghost', script: 'no-such-observer.js', everyMin: 60 }] });
    t = tick('2026-11-04T00:20:00Z');
    check('an unshipped bare name is CONFIG-INVALID and names the path beside the clock',
        (t.line || '').startsWith(`observers: CONFIG-INVALID ghost: ${path.join(clockDir, 'no-such-observer.js')} does not exist`), t.out);
    w(cfg, { observers: [{ id: 'shipped', script: 'prd-states.js', everyMin: 60 }] });
    t = tick('2026-11-04T00:25:00Z');
    check('a shipped bare name runs from beside the clock', /^observers: 1 configured, ran shipped exit 0 in \d+ ms$/.test(t.line || ''), t.out);
} catch (e) {
    failed++;
    console.log(`FAIL the suite crashed: ${e.stack || e}`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\nbrain-clock observers: ${ran - failed}/${ran} checks passed`);
process.exitCode = failed ? 1 : 0;
