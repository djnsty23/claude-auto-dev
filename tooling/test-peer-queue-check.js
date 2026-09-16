#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/peer-queue-check.js.
//
// The script reads the peer-send ledger and decides, for each queued send, if
// the target session processed it. Every input is a fixture here: a ledger, a
// desktop session store nested the way the real one is, and transcripts under a
// temp CLAUDE_CONFIG_DIR.
//
// The case that matters most is the enqueue row. The host writes the message
// text into the target transcript as a `queue-operation` row the moment it is
// queued, long before it is processed. A check that searched every row would
// find the text there and call every lost message processed. So the lost
// fixtures carry exactly that row, and must still come back lost.
//
// Run: node tooling/test-peer-queue-check.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'peer-queue-check.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail !== undefined ? '  (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-queue-'));
const STORE = path.join(TMP, 'store');
const CONFIG = path.join(TMP, 'config');
const PROJECTS = path.join(CONFIG, 'projects');
const MIN = 60000;
const now = Date.now();
const ago = (m) => new Date(now - m * MIN).toISOString();

function storeRecord(desktopId, cliId) {
    // Two directories deep, as the real store nests them. A flat read finds nothing.
    const dir = path.join(STORE, 'account-test', 'org-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, desktopId + '.json'), JSON.stringify({ sessionId: desktopId, cliSessionId: cliId, title: 'fixture' }), 'utf8');
}

function transcript(cliId, rows, mtimeMinutesAgo) {
    const dir = path.join(PROJECTS, 'project-test');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, cliId + '.jsonl');
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const t = new Date(now - mtimeMinutesAgo * MIN);
    fs.utimesSync(file, t, t);
}

const enqueueRow = (text, m) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: ago(m), sessionId: 'x', content: text });
const userRow = (content, m) => ({ type: 'user', timestamp: ago(m), origin: { kind: 'peer' }, message: { role: 'user', content } });
// A prompt injected into a RUNNING turn is an attachment row, not a user row.
const attachmentRow = (type, prompt, m) => ({ type: 'attachment', timestamp: ago(m), attachment: { type, prompt, commandMode: 'prompt', origin: { kind: 'peer' } } });

// The full messages, as a sender would have written them. The probe is what the
// ledger hook stores: the first 80 characters with whitespace collapsed.
const MSG = {
    A: 'Please rebase\nonto main, then run   the "full" gate and report the exit code with the last fifteen log lines.',
    B: 'Pending message: the target is mid-turn and its transcript is still being written right now, so wait.',
    C: 'Lost message: the target stopped at its context limit and this never reached a turn at all, sadly.',
    D: 'A message to a session the store has never heard of, which cannot be resolved to any transcript.',
    E: 'A message to a session that has a store record but whose transcript file does not exist anywhere.',
    F: 'An old copy of this text was processed before this send, so the earlier row must not count as proof.',
    G: 'Processed as a content block array rather than a plain string, which the host also writes sometimes.',
    H: 'Processed inside a running turn, so it arrives as a queued_command attachment and never as a user row.',
};
const probe = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 80);
const entry = (key, target, delivery, atMinutesAgo) => ({ at: ago(atMinutesAgo), target, messageId: 'MSG_TEST_' + key, delivery, sha256: '0', probe: probe(MSG[key]) });

storeRecord('local_TEST_A', 'cli-test-a');
storeRecord('local_TEST_B', 'cli-test-b');
storeRecord('local_TEST_C', 'cli-test-c');
storeRecord('local_TEST_E', 'cli-test-e');
storeRecord('local_TEST_F', 'cli-test-f');
storeRecord('local_TEST_G', 'cli-test-g');
storeRecord('local_TEST_H', 'cli-test-h');

// A: processed. The enqueue row comes first, then the real user row after the send.
transcript('cli-test-a', [enqueueRow(MSG.A, 61), userRow('<peer message>\n' + MSG.A, 50)], 120);
// B: pending. Only the enqueue row, and the transcript is being written now.
transcript('cli-test-b', [enqueueRow(MSG.B, 59)], 1);
// C: lost. Only the enqueue row, and the transcript went quiet two hours ago.
// It also carries the text in an attachment of ANOTHER type, which proves nothing.
transcript('cli-test-c', [enqueueRow(MSG.C, 59), attachmentRow('hook_additional_context', MSG.C, 58)], 120);
// F: lost. The text appears in a user row, but ninety minutes before this send.
transcript('cli-test-f', [userRow(MSG.F, 90), enqueueRow(MSG.F, 59)], 120);
// G: processed, with content as an array of text blocks.
transcript('cli-test-g', [userRow([{ type: 'text', text: MSG.G }], 55)], 120);
// H: processed mid-turn: enqueue, then the queued_command attachment, then remove.
transcript('cli-test-h', [enqueueRow(MSG.H, 59), attachmentRow('queued_command', MSG.H, 58),
    { type: 'queue-operation', operation: 'remove', timestamp: ago(58), sessionId: 'x' }], 120);

function writeLedger(name, entries) {
    const file = path.join(TMP, name + '.jsonl');
    fs.writeFileSync(file, entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n', 'utf8');
    return file;
}

function run(args, env) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { AUTODEV_DESKTOP_SESSION_STORE: STORE, CLAUDE_CONFIG_DIR: CONFIG }, env || {}),
    });
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { json = null; }
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', json };
}
const detail = (r) => 'exit ' + r.code + ', stdout ' + JSON.stringify(r.out.slice(0, 200)) + ', stderr ' + JSON.stringify(r.err.slice(0, 120));

try {
    const full = writeLedger('full', [
        entry('A', 'local_TEST_A', 'queued', 60),
        entry('B', 'local_TEST_B', 'queued', 60),
        entry('C', 'local_TEST_C', 'queued', 60),
        entry('D', 'local_TEST_UNKNOWN', 'queued', 60),
        entry('E', 'local_TEST_E', 'queued', 60),
        entry('F', 'local_TEST_F', 'queued', 60),
        entry('G', 'local_TEST_G', 'queued', 60),
        entry('H', 'local_TEST_H', 'queued', 60),
        // Outside the population: delivered, too young, too old.
        entry('C', 'local_TEST_C', 'delivered', 60),
        entry('C', 'local_TEST_C', 'queued', 5),
        entry('C', 'local_TEST_C', 'queued', 8 * 24 * 60),
        'not json at all',
    ]);

    // ---- the four verdicts, in JSON --------------------------------------------
    {
        const r = run(['--json'], { AUTODEV_PEER_LEDGER: full });
        const j = r.json || {};
        check('a ledger with a lost message exits 1', r.code === 1, detail(r));
        check('  --json prints one parseable object', !!r.json, detail(r));
        check('  scanned counts only queued sends aged 20 min to 7 days', j.scanned === 8, 'scanned ' + j.scanned);
        check('  entries and malformed describe the whole ledger', j.entries === 11 && j.malformed === 1, j.entries + ' / ' + j.malformed);
        check('  processed: a user row after the send (string or blocks) or a queued_command attachment', j.processed === 3, 'processed ' + j.processed);
        check('  pending: not found, transcript written in the last 20 minutes', j.pending === 1, 'pending ' + j.pending);
        const lostIds = (j.lost || []).map((l) => l.messageId).sort().join(',');
        check('  lost: the enqueue row alone is NOT proof of processing', lostIds.includes('MSG_TEST_C'), lostIds);
        check('  lost: a matching row from before the send is NOT proof either', lostIds.includes('MSG_TEST_F'), lostIds);
        check('  lost lists exactly those two', lostIds === 'MSG_TEST_C,MSG_TEST_F', lostIds);
        const lostC = (j.lost || []).find((l) => l.messageId === 'MSG_TEST_C') || {};
        check('  a lost row carries target, messageId, at and probe', lostC.target === 'local_TEST_C' && typeof lostC.at === 'string' && lostC.probe === probe(MSG.C), JSON.stringify(lostC));
        const unknown = (j.unknown || []).map((u) => u.messageId + ':' + u.reason).sort();
        check('  unknown: a target missing from the store, and one with no transcript', unknown.length === 2
            && /MSG_TEST_D:target not in the desktop session store/.test(unknown.join('|')) && /MSG_TEST_E:no transcript/.test(unknown.join('|')), unknown.join('|'));
        check('  ok is false while something is lost', j.ok === false);
    }

    // ---- the human summary always states the population --------------------
    {
        const r = run([], { AUTODEV_PEER_LEDGER: full });
        check('the human summary states the population scanned', /11 entries \(1 malformed\), 8 queued send\(s\) aged 20 min to 7 days scanned/.test(r.out), detail(r));
        check('  and the four counts', /processed 3, pending 1, lost 2, unknown 2/.test(r.out), detail(r));
        check('  and names each lost message', /LOST\s+local_TEST_C message MSG_TEST_C/.test(r.out) && /LOST\s+local_TEST_F message MSG_TEST_F/.test(r.out), detail(r));
        check('  and each unknown one with its reason', /UNKNOWN\s+local_TEST_UNKNOWN .*target not in the desktop session store/.test(r.out), detail(r));
    }

    // ---- nothing lost: exit 0 --------------------------------------------------
    {
        const clean = writeLedger('clean', [entry('A', 'local_TEST_A', 'queued', 60), entry('B', 'local_TEST_B', 'queued', 60), entry('D', 'local_TEST_UNKNOWN', 'queued', 60)]);
        const r = run(['--json'], { AUTODEV_PEER_LEDGER: clean });
        check('processed, pending and unknown only: exit 0 and ok', r.code === 0 && r.json && r.json.ok === true && r.json.scanned === 3, detail(r));
    }
    {
        const r = run(['--min-age-min', '120'], { AUTODEV_PEER_LEDGER: full });
        check('--min-age-min above every send: 0 scanned, exit 0, population still stated', r.code === 0 && /11 entries \(1 malformed\), 0 queued send\(s\) aged 120 min to 7 days scanned/.test(r.out), detail(r));
    }
    {
        const empty = writeLedger('empty', []);
        const r = run([], { AUTODEV_PEER_LEDGER: empty, AUTODEV_DESKTOP_SESSION_STORE: path.join(TMP, 'no-store') });
        check('an empty ledger needs no store: exit 0 with a population of 0', r.code === 0 && /0 entries \(0 malformed\), 0 queued/.test(r.out), detail(r));
    }

    // ---- indeterminate: exit 2, never clean -----------------------------------
    {
        const r = run(['--json'], { AUTODEV_PEER_LEDGER: path.join(TMP, 'missing.jsonl') });
        check('an unreadable ledger exits 2', r.code === 2 && r.json && r.json.ok === false && /NOT a clean result/.test(r.json.error), detail(r));
        const h = run([], { AUTODEV_PEER_LEDGER: path.join(TMP, 'missing.jsonl') });
        check('  and the human form says INDETERMINATE on stderr', h.code === 2 && /INDETERMINATE/.test(h.err) && h.out === '', detail(h));
    }
    {
        const r = run(['--json'], { AUTODEV_PEER_LEDGER: full, AUTODEV_DESKTOP_SESSION_STORE: path.join(TMP, 'no-store') });
        check('an unreadable session store exits 2 when there is something to judge', r.code === 2 && r.json && /desktop session store/.test(r.json.error), detail(r));
    }
    {
        const r = run(['--json'], { AUTODEV_PEER_LEDGER: full, CLAUDE_CONFIG_DIR: path.join(TMP, 'no-config') });
        check('an unreadable transcripts directory exits 2', r.code === 2 && r.json && /transcripts directory/.test(r.json.error), detail(r));
    }
    {
        const r = run(['--min-age-min', 'soon'], { AUTODEV_PEER_LEDGER: full });
        check('a malformed --min-age-min exits 2', r.code === 2 && /non-negative number/.test(r.err), detail(r));
    }

    // ---- --help ---------------------------------------------------------------
    {
        const r = run(['--help'], { AUTODEV_PEER_LEDGER: path.join(TMP, 'missing.jsonl') });
        check('--help prints usage and exits 0 without reading the ledger', r.code === 0 && /^usage: /.test(r.out) && r.err === '', detail(r));
    }
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
