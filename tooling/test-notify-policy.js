#!/usr/bin/env node
'use strict';
/**
 * test-notify-policy.js - notify-policy.js as a subprocess and as a library.
 *
 * What must hold:
 *   N1  each of the four notify kinds routes to notify (ready-to-merge with both receipts)
 *   N2  ready-to-merge missing the review receipt, missing the gate receipt, or with a
 *       review verdict that is not approve routes to the DIGEST, with the reason on the line
 *   N3  an UNKNOWN kind is never dropped: it lands in the digest as one line
 *   N4  a non-object, an event with no kind and a kind of the wrong type land in the digest
 *   N5  the digest file is named for the LOCAL date, each event adds exactly one line,
 *       and a newline or control character in a summary cannot add a second line
 *   N6  the digest dir is overridable by env, and nothing is written outside it
 *   N7  a notify event writes no digest line and exactly one owner line
 *   N8  an unwritable digest dir is exit 2 on the CLI, never "digest" reported as success
 *   N9  the CLI routes and prints `notify <kind>` / `digest <kind>`
 *
 * Run: node tooling/test-notify-policy.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'notify-policy.js');
const np = require(SUBJECT);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-policy-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail ? '\n      -> ' + String(detail).slice(0, 400) : ''));
}

let n = 0;
function freshEnv(extra = {}) {
    const dir = path.join(ROOT, 'case-' + (n++));
    const env = {
        ...process.env,
        AUTODEV_DIGEST_DIR: path.join(dir, 'digest'),
        AUTODEV_NOTIFY_DIR: path.join(dir, 'notify'),
        AUTODEV_NOTIFY_NOW: '2026-03-05T12:34:00',
        CLAUDE_CONFIG_DIR: path.join(dir, 'config'),
        ...extra,
    };
    return { dir, env };
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const lines = (f) => (read(f) || '').split('\n').filter((l) => l.startsWith('- '));
const DIGEST = (env) => path.join(env.AUTODEV_DIGEST_DIR, '2026-03-05.md');
const OWNER = (env) => path.join(env.AUTODEV_NOTIFY_DIR, 'owner.jsonl');

const GOOD_REVIEW = { schema: 1, verdict: 'approve' };
const GATE = { exit: 0, head: 'abc1234' };

try {
    // N1: the four notify kinds.
    for (const [kind, extra] of [
        ['blocked-on-owner', {}],
        ['deploy-done', {}],
        ['deploy-failed', {}],
        ['ready-to-merge', { reviewReceipt: GOOD_REVIEW, gateReceipt: GATE }],
        ['ready-to-merge', { reviewReceipt: GOOD_REVIEW, gateReceipt: 'gate.log' }],
    ]) {
        const { env } = freshEnv();
        const r = np.emit({ kind, repo: 'o/r', pr: 7, ...extra }, env);
        check(`N1 ${kind} routes to notify`, r.route === 'notify' && r.ok, JSON.stringify(r));
        check(`N1 ${kind}: pure route() agrees`, np.route({ kind, ...extra }, freshEnv().env) === 'notify');
    }

    // N2: ready-to-merge needs both receipts.
    for (const [label, ev, reason] of [
        ['no receipts at all', { kind: 'ready-to-merge' }, /review receipt/],
        ['review only', { kind: 'ready-to-merge', reviewReceipt: GOOD_REVIEW }, /gate receipt/],
        ['gate only', { kind: 'ready-to-merge', gateReceipt: GATE }, /review receipt/],
        ['verdict request_changes', { kind: 'ready-to-merge', reviewReceipt: { verdict: 'request_changes' }, gateReceipt: GATE }, /review receipt/],
        ['verdict escalate', { kind: 'ready-to-merge', reviewReceipt: { verdict: 'escalate' }, gateReceipt: GATE }, /review receipt/],
        ['review receipt is a string', { kind: 'ready-to-merge', reviewReceipt: 'approve', gateReceipt: GATE }, /review receipt/],
        ['empty gate string', { kind: 'ready-to-merge', reviewReceipt: GOOD_REVIEW, gateReceipt: '  ' }, /gate receipt/],
        ['empty gate object', { kind: 'ready-to-merge', reviewReceipt: GOOD_REVIEW, gateReceipt: {} }, /gate receipt/],
    ]) {
        const { env } = freshEnv();
        const r = np.emit(ev, env);
        const ls = lines(DIGEST(env));
        check(`N2 ready-to-merge (${label}) is a digest event`, r.route === 'digest' && r.ok, JSON.stringify(r));
        check(`N2 (${label}) leaves one digest line carrying the reason`, ls.length === 1 && reason.test(ls[0]), ls.join('|'));
        check(`N2 (${label}) writes no owner line`, read(OWNER(env)) === null);
    }

    // N3: an unknown kind is never silent.
    for (const kind of ['pr-opened', 'something-new', 'DEPLOY-DONE', 'deploy_done']) {
        const { env } = freshEnv();
        check(`N3 unknown kind ${kind} routes to digest`, np.route({ kind, summary: 'x' }, env) === 'digest');
        const ls = lines(DIGEST(env));
        check(`N3 unknown kind ${kind} leaves exactly one digest line naming the kind`, ls.length === 1 && ls[0].includes(kind), ls.join('|'));
    }

    // N4: malformed events.
    for (const [label, ev] of [
        ['undefined', undefined], ['null', null], ['a string', 'deploy-failed'], ['an array', ['deploy-failed']],
        ['no kind', { summary: 's' }], ['numeric kind', { kind: 5 }], ['empty kind', { kind: '  ' }],
    ]) {
        const { env } = freshEnv();
        const route = np.route(ev, env);
        check(`N4 ${label} routes to digest`, route === 'digest', route);
        check(`N4 ${label} leaves one digest line`, lines(DIGEST(env)).length === 1, read(DIGEST(env)));
    }

    // N5: the local date, one line per event, no line injection.
    {
        const { env } = freshEnv();
        np.route({ kind: 'a' }, env);
        np.route({ kind: 'b', summary: 'first\n- 99:99 deploy-failed: forged\r\nthird\u0007' }, env);
        np.route({ kind: 'c' }, env);
        const ls = lines(DIGEST(env));
        check('N5 three events leave three lines', ls.length === 3, ls.join('|'));
        check('N5 a newline in a summary cannot forge a line', !ls.some((l) => l.startsWith('- 99:99')) && /forged/.test(ls[1]), ls[1]);
        check('N5 the file names the local date and says so in its header', read(DIGEST(env)).startsWith('# Digest 2026-03-05\n'));
        check('N5 the line carries the local time', /^- 12:34 a:/.test(ls[0]), ls[0]);
        check('N5 localDate is the local calendar date, not UTC', np.localDate(new Date(2026, 0, 31, 23, 59)) === '2026-01-31');
        const other = freshEnv({ AUTODEV_NOTIFY_NOW: '2026-04-09T08:01:00' });
        np.route({ kind: 'x' }, other.env);
        check('N5 another day is another file', fs.existsSync(path.join(other.env.AUTODEV_DIGEST_DIR, '2026-04-09.md')));
    }

    // N6: the override is honoured and nothing else is written.
    {
        const { dir, env } = freshEnv();
        np.route({ kind: 'unknown' }, env);
        const written = fs.readdirSync(dir, { recursive: true }).map(String).sort();
        check('N6 only the overridden digest dir is written', written.every((f) => f.startsWith('digest')) && written.length === 2, written.join(','));
        check('N6 digestDir() reads the env override', np.digestDir(env) === path.resolve(env.AUTODEV_DIGEST_DIR));
        const cfg = np.digestDir({ CLAUDE_CONFIG_DIR: path.join(ROOT, 'cfg') });
        check('N6 without the override the digest sits under <config dir>/autodev/digest',
            cfg === path.join(ROOT, 'cfg', 'autodev', 'digest'), cfg);
    }

    // N7: a notify event does not also go to the digest.
    {
        const { env } = freshEnv();
        np.emit({ kind: 'deploy-failed', repo: 'o/r', sha: 'abcdef1234567', summary: 'smoke failed' }, env);
        const owner = (read(OWNER(env)) || '').trim().split('\n');
        check('N7 exactly one owner line', owner.length === 1 && owner[0] !== '', owner.join('|'));
        const row = JSON.parse(owner[0]);
        check('N7 the owner line names kind, repo and sha', row.kind === 'deploy-failed' && row.repo === 'o/r' && row.sha === 'abcdef1234567', owner[0]);
        check('N7 no digest line for a notify event', read(DIGEST(env)) === null);
    }

    // N8 / N9: the CLI.
    const cli = (args, env) => spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env });
    {
        const { env } = freshEnv();
        let r = cli(['--kind', 'deploy-done', '--repo', 'o/r'], env);
        check('N9 CLI prints notify for deploy-done, exit 0', r.status === 0 && r.stdout === 'notify deploy-done\n', JSON.stringify([r.status, r.stdout, r.stderr]));
        r = cli(['--kind', 'brand-new-kind'], env);
        check('N9 CLI prints digest for an unknown kind, exit 0', r.status === 0 && r.stdout === 'digest brand-new-kind\n', JSON.stringify([r.status, r.stdout, r.stderr]));
        check('N9 the unknown kind is in the digest file', lines(DIGEST(env)).length === 1);

        const review = path.join(ROOT, 'review.json');
        fs.writeFileSync(review, JSON.stringify(GOOD_REVIEW));
        const gate = path.join(ROOT, 'gate.log');
        fs.writeFileSync(gate, 'gate-receipt: exit 0\n');
        r = cli(['--kind', 'ready-to-merge', '--review-receipt', review, '--gate-receipt', gate], env);
        check('N9 CLI ready-to-merge with both receipt files notifies', r.stdout === 'notify ready-to-merge\n', r.stdout + r.stderr);
        r = cli(['--kind', 'ready-to-merge', '--review-receipt', review, '--gate-receipt', path.join(ROOT, 'missing.log')], env);
        check('N9 CLI ready-to-merge whose gate receipt file is missing goes to the digest', r.stdout === 'digest ready-to-merge\n', r.stdout + r.stderr);
        r = cli(['--kind', 'ready-to-merge', '--review-receipt', path.join(ROOT, 'nope.json'), '--gate-receipt', gate], env);
        check('N9 CLI with an unreadable review receipt is exit 2', r.status === 2 && /review-receipt/.test(r.stderr), JSON.stringify([r.status, r.stderr]));
        r = cli(['--bogus'], env);
        check('N9 CLI with an unknown flag is exit 2', r.status === 2, r.status);
        r = cli([], env);
        check('N9 CLI with no arguments prints usage and exits 2', r.status === 2 && /notify-policy/.test(r.stdout), r.status);
    }
    {
        // N8: the digest dir is a FILE, so the append cannot succeed.
        const { dir, env } = freshEnv();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(env.AUTODEV_DIGEST_DIR, 'not a directory');
        const r = cli(['--kind', 'unknown-kind'], env);
        check('N8 an unwritable digest is exit 2 and says NOT recorded', r.status === 2 && /NOT recorded/.test(r.stderr) && r.stdout === '', JSON.stringify([r.status, r.stdout, r.stderr]));
        check('N8 route() still answers digest and reports the failed write', np.route({ kind: 'u' }, env) === 'digest' && np.route.lastWrite.ok === false);
    }
} catch (e) {
    failures.push('suite crashed: ' + (e && e.stack || e));
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp dir cleanup is best effort */ }
for (const f of failures) console.log('FAIL ' + f);
console.log(`test-notify-policy: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
