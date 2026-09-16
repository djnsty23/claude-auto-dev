#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/hooks/peer-send-ledger.js.
//
// The hook appends one line per peer message send, carrying the delivery state
// the host reported, so peer-queue-check.js can later find a queued message its
// target never processed. Driven as a subprocess with AUTODEV_PEER_LEDGER
// pointed at a temp file, so no case touches a real ledger.
//
// The response arrives in more than one shape depending on the tool and host
// version, and a parser that handled one shape would record nothing for the
// others while staying silent. So each shape gets its own case. Every case also
// asserts zero bytes on both streams, since the hook must never speak.
//
// Run: node tooling/test-peer-send-ledger.js

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'peer-send-ledger.js');
const TOOL = 'mcp__ccd_session_mgmt__send_message';

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail !== undefined ? '  (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-ledger-'));
let n = 0;
const freshLedger = () => path.join(TMP, 'l' + (++n), 'nested', 'peer-sends.jsonl');

function run(payload, ledger, rawInput) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: rawInput !== undefined ? rawInput : JSON.stringify(payload),
        encoding: 'utf8',
        env: Object.assign({}, process.env, { AUTODEV_PEER_LEDGER: ledger }),
    });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const silent = (r) => r.code === 0 && r.out === '' && r.err === '';
const detail = (r) => 'exit ' + r.code + ', stdout ' + JSON.stringify(r.out.slice(0, 80)) + ', stderr ' + JSON.stringify(r.err.slice(0, 80));
function rows(ledger) {
    try { return fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return null; }
}

const TARGET = 'local_TEST_TARGET_1';
const MESSAGE = '  Status check:\n\n  the   suite is green,\tplease rebase onto main and re-run the gate before pushing anything further today.';
const queuedText = 'Message queued for session ' + TARGET + ' ("t"): a turn is in progress there. (delivery: queued; message_id: MSG_TEST_Q1)';
const deliveredText = 'Message delivered to session ' + TARGET + ' ("t"); its turn has started on it. (delivery: delivered; message_id: MSG_TEST_D1)';
const payload = (response, extra) => Object.assign({
    hook_event_name: 'PostToolUse', tool_name: TOOL, tool_use_id: 'toolu_test',
    tool_input: { session_id: TARGET, message: MESSAGE }, tool_response: response,
}, extra || {});

try {
    // ---- a queued send, response as a plain string --------------------------
    {
        const ledger = freshLedger();
        const before = Date.now();
        const r = run(payload(queuedText), ledger);
        check('a queued send is recorded silently', silent(r), detail(r));
        const got = rows(ledger);
        check('  exactly one line is appended, in a directory the hook created', Array.isArray(got) && got.length === 1, JSON.stringify(got));
        const row = (got && got[0]) || {};
        check('  target is the tool input session_id', row.target === TARGET, row.target);
        check('  delivery and messageId come from the response marker', row.delivery === 'queued' && row.messageId === 'MSG_TEST_Q1', JSON.stringify(row));
        const at = Date.parse(row.at);
        check('  at is an ISO time from this run', typeof row.at === 'string' && row.at.endsWith('Z') && at >= before - 1000 && at <= Date.now() + 1000, row.at);
        check('  sha256 is the hash of the exact message', row.sha256 === crypto.createHash('sha256').update(MESSAGE, 'utf8').digest('hex'), row.sha256);
        const expectedProbe = MESSAGE.replace(/\s+/g, ' ').trim().slice(0, 80);
        check('  probe is the first 80 characters with whitespace collapsed', row.probe === expectedProbe && row.probe.length === 80, JSON.stringify(row.probe));
        check('  the line carries exactly the six documented keys', Object.keys(row).sort().join(',') === 'at,delivery,messageId,probe,sha256,target', Object.keys(row).join(','));
    }

    // ---- a delivered send, response as an array of content blocks -----------
    {
        const ledger = freshLedger();
        const r = run(payload([{ type: 'text', text: deliveredText }]), ledger);
        const got = rows(ledger) || [];
        check('a delivered send, response as content blocks, is recorded silently', silent(r) && got.length === 1 && got[0].delivery === 'delivered' && got[0].messageId === 'MSG_TEST_D1', detail(r) + ' ' + JSON.stringify(got));
    }

    // ---- response as an object wrapping blocks ------------------------------
    {
        const ledger = freshLedger();
        const r = run(payload({ content: [{ type: 'text', text: queuedText }], is_error: false }), ledger);
        const got = rows(ledger) || [];
        check('a response object wrapping content blocks is parsed', silent(r) && got.length === 1 && got[0].delivery === 'queued', detail(r) + ' ' + JSON.stringify(got));
    }

    // ---- the LAST marker wins ------------------------------------------------
    // The host appends its marker at the end of the result. Text earlier in the
    // result, such as a quoted session title, can carry a marker-shaped string.
    {
        const ledger = freshLedger();
        const r = run(payload([
            { type: 'text', text: 'Session titled "(delivery: delivered; message_id: MSG_TEST_DECOY)" is busy.' },
            { type: 'text', text: queuedText },
        ]), ledger);
        const got = rows(ledger) || [];
        check('when two blocks hold markers, the last one is recorded', silent(r) && got.length === 1 && got[0].messageId === 'MSG_TEST_Q1' && got[0].delivery === 'queued', JSON.stringify(got));
        const ledger2 = freshLedger();
        const r2 = run(payload('Session titled "(delivery: delivered; message_id: MSG_TEST_DECOY)" is busy. ' + queuedText), ledger2);
        const got2 = rows(ledger2) || [];
        check('when one string holds two markers, the last one is recorded', silent(r2) && got2.length === 1 && got2[0].messageId === 'MSG_TEST_Q1', JSON.stringify(got2));
    }

    // ---- appends, never rewrites ---------------------------------------------
    {
        const ledger = freshLedger();
        run(payload(queuedText), ledger);
        run(payload([{ type: 'text', text: deliveredText }]), ledger);
        const r = run(payload('Message not delivered: session is archived. (delivery: undelivered; message_id: MSG_TEST_U1)'), ledger);
        const got = rows(ledger) || [];
        check('three sends append three lines in order', silent(r) && got.map((g) => g.delivery).join(',') === 'queued,delivered,undelivered', JSON.stringify(got.map((g) => g.delivery)));
    }

    // ---- nothing to record ----------------------------------------------------
    {
        const ledger = freshLedger();
        const r1 = run(payload('Message sent, but this text carries no delivery marker at all.'), ledger);
        check('an unparseable response appends nothing and prints nothing', silent(r1) && rows(ledger) === null && !fs.existsSync(ledger), detail(r1));
        const r2 = run(payload(undefined), ledger);
        check('a missing response appends nothing', silent(r2) && !fs.existsSync(ledger), detail(r2));
        const r3 = run(Object.assign(payload(queuedText), { tool_name: 'mcp__slack__send_message' }), ledger);
        check('a different tool sharing the name suffix appends nothing', silent(r3) && !fs.existsSync(ledger), detail(r3));
        const r4 = run(payload(queuedText, { tool_input: { session_id: TARGET } }), ledger);
        check('a send with no message appends nothing', silent(r4) && !fs.existsSync(ledger), detail(r4));
        const r5 = run(null, ledger, 'this is not json');
        check('garbage stdin appends nothing and prints nothing', silent(r5) && !fs.existsSync(ledger), detail(r5));
    }

    // ---- fail open when the ledger cannot be written -------------------------
    {
        const dirAsFile = path.join(TMP, 'is-a-directory');
        fs.mkdirSync(dirAsFile, { recursive: true });
        const r = run(payload(queuedText), dirAsFile);
        check('an unwritable ledger path fails OPEN with zero bytes', silent(r), detail(r));
    }

    // ---- pruning ---------------------------------------------------------------
    {
        const ledger = freshLedger();
        fs.mkdirSync(path.dirname(ledger), { recursive: true });
        const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
        const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
        const pad = 'x'.repeat(900);
        const lines = [];
        for (let i = 0; i < 1100; i++) lines.push(JSON.stringify({ at: old, target: 'local_OLD', messageId: 'OLD_' + i, delivery: 'queued', sha256: '', probe: pad }));
        lines.push(JSON.stringify({ at: recent, target: 'local_RECENT', messageId: 'RECENT_1', delivery: 'queued', sha256: '', probe: 'keep me' }));
        lines.push('not json, dropped by the prune');
        fs.writeFileSync(ledger, lines.join('\n') + '\n', 'utf8');
        const sizeBefore = fs.statSync(ledger).size;
        const r = run(payload(queuedText), ledger);
        const got = rows(ledger) || [];
        check('fixture: the ledger starts above 1 MB', sizeBefore > 1024 * 1024, String(sizeBefore));
        check('past 1 MB, lines older than 7 days are pruned', silent(r) && got.every((g) => g.target !== 'local_OLD'), got.length + ' rows');
        check('  lines inside 7 days survive the prune, and the new send is kept', got.length === 2 && got[0].messageId === 'RECENT_1' && got[1].messageId === 'MSG_TEST_Q1', JSON.stringify(got.map((g) => g.messageId)));
        check('  no temp file is left beside the ledger', fs.readdirSync(path.dirname(ledger)).length === 1, fs.readdirSync(path.dirname(ledger)).join(','));
    }
    {
        const ledger = freshLedger();
        fs.mkdirSync(path.dirname(ledger), { recursive: true });
        const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
        fs.writeFileSync(ledger, JSON.stringify({ at: old, target: 'local_OLD', messageId: 'OLD_SMALL', delivery: 'queued', sha256: '', probe: 'p' }) + '\n', 'utf8');
        const r = run(payload(queuedText), ledger);
        const got = rows(ledger) || [];
        check('CONTROL: under 1 MB, old lines are left alone', silent(r) && got.length === 2 && got[0].messageId === 'OLD_SMALL', JSON.stringify(got.map((g) => g.messageId)));
    }

    // ---- pruning rewrites only when it drops something, under a lock ----------
    // A ledger past 1 MB of recent lines used to be rewritten and renamed on
    // every send, and a line another session appended between the read and the
    // rename was lost. These cases fail against that prune.
    const recentLedger = (count, pad) => {
        const ledger = freshLedger();
        fs.mkdirSync(path.dirname(ledger), { recursive: true });
        const recent = new Date(Date.now() - 60 * 1000).toISOString();
        const lines = [];
        for (let i = 0; i < count; i++) lines.push(JSON.stringify({ at: recent, target: 'local_RECENT', messageId: 'R_' + i, delivery: 'queued', sha256: '', probe: pad }));
        fs.writeFileSync(ledger, lines.join('\n') + '\n', 'utf8');
        return ledger;
    };
    const oldLedger = () => {
        const ledger = freshLedger();
        fs.mkdirSync(path.dirname(ledger), { recursive: true });
        const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
        const lines = [];
        for (let i = 0; i < 1100; i++) lines.push(JSON.stringify({ at: old, target: 'local_OLD', messageId: 'OLD_' + i, delivery: 'queued', sha256: '', probe: 'x'.repeat(900) }));
        fs.writeFileSync(ledger, lines.join('\n') + '\n', 'utf8');
        return ledger;
    };
    {
        const ledger = recentLedger(1100, 'y'.repeat(900));
        const link = path.join(TMP, 'hardlink-' + n + '.jsonl');
        let linked = true;
        try { fs.linkSync(ledger, link); } catch { linked = false; }
        check('fixture: a hard link to the ledger can be made, so a rewrite is observable', linked);
        const r = run(payload(queuedText), ledger);
        const got = rows(ledger) || [];
        check('past 1 MB with nothing to drop, every line is kept and the send appended', silent(r) && got.length === 1101 && got[1100].messageId === 'MSG_TEST_Q1', detail(r) + ' ' + got.length + ' rows');
        // The hook appends before it prunes, so the link sees the send either
        // way. What a rewrite breaks is the link itself: after a rename the
        // ledger path names a new file, and a line written through the link
        // no longer shows up there.
        if (linked) fs.appendFileSync(link, JSON.stringify({ at: new Date().toISOString(), target: 'local_LINK', messageId: 'MSG_TEST_VIA_LINK', delivery: 'queued', sha256: '', probe: 'p' }) + '\n', 'utf8');
        const after = rows(ledger) || [];
        check('  and the file is appended in place, not rewritten (the ledger and a hard link are still one file)', linked && after.length === 1102 && after[1101].messageId === 'MSG_TEST_VIA_LINK', after.length + ' rows, last ' + (after.length ? after[after.length - 1].messageId : '(none)'));
    }
    {
        const ledger = oldLedger();
        const lock = ledger + '.lock';
        fs.writeFileSync(lock, '', 'utf8');
        const r = run(payload(queuedText), ledger);
        const got = rows(ledger) || [];
        check('a fresh lock held by another prune skips this prune: the old lines stay', silent(r) && got.length === 1101 && got[0].messageId === 'OLD_0', detail(r) + ' ' + got.length + ' rows');
        check('  but not the append: the send is still recorded', got.length > 0 && got[got.length - 1].messageId === 'MSG_TEST_Q1', JSON.stringify(got.slice(-1)));
        check('  and the lock is left for the session that owns it', fs.existsSync(lock));
    }
    {
        const ledger = oldLedger();
        const lock = ledger + '.lock';
        fs.writeFileSync(lock, '', 'utf8');
        const stale = new Date(Date.now() - 2 * 60 * 1000);
        fs.utimesSync(lock, stale, stale);
        const r = run(payload(queuedText), ledger);
        const got = rows(ledger) || [];
        check('a lock older than a minute is stale: it is removed and the prune runs', silent(r) && got.length === 1 && got[0].messageId === 'MSG_TEST_Q1' && !fs.existsSync(lock),
            detail(r) + ' ' + got.length + ' rows, lock ' + (fs.existsSync(lock) ? 'present' : 'gone'));
    }
    {
        const ledger = recentLedger(4500, 'z'.repeat(1000));
        const sizeBefore = fs.statSync(ledger).size;
        check('fixture: the recent-only ledger starts above 4 MB', sizeBefore > 4 * 1024 * 1024, String(sizeBefore));
        const r = run(payload(queuedText), ledger);
        const got = rows(ledger) || [];
        const size = fs.statSync(ledger).size;
        check('past 4 MB of recent lines, the ledger is cut back to fit in 1 MB', silent(r) && size <= 1024 * 1024 && got.length > 0, detail(r) + ' size ' + size);
        const ids = got.map((g) => g.messageId);
        const firstIndex = Number(String(ids[0]).slice(2));
        const contiguous = ids.slice(0, -1).every((id, k) => id === 'R_' + (firstIndex + k)) && ids[ids.length - 2] === 'R_4499';
        check('  the newest lines are the ones kept, in order, ending with the new send', firstIndex > 0 && contiguous && ids[ids.length - 1] === 'MSG_TEST_Q1', ids.slice(0, 2).join(',') + ' ... ' + ids.slice(-2).join(','));
        check('  and the lock is released', !fs.existsSync(ledger + '.lock'), fs.readdirSync(path.dirname(ledger)).join(','));
    }
    {
        // Another session appends while this prune is between its read and its
        // rename. The preload does that append right after the new file is
        // written, which is the moment the old prune lost it.
        const ledger = oldLedger();
        const preload = path.join(TMP, 'concurrent-append.js');
        const lockSeen = path.join(TMP, 'lock-seen-' + n + '.txt');
        fs.writeFileSync(preload, [
            "'use strict';",
            "const fs = require('fs');",
            'const realWrite = fs.writeFileSync;',
            'let appended = false;',
            'fs.writeFileSync = function (file, ...rest) {',
            '    const out = realWrite.call(fs, file, ...rest);',
            '    const ledger = process.env.AUTODEV_PEER_LEDGER;',
            "    if (!appended && typeof file === 'string' && file.endsWith('.tmp')) {",
            '        appended = true;',
            "        realWrite.call(fs, process.env.TEST_LOCK_SEEN, fs.existsSync(ledger + '.lock') ? 'held' : 'absent', 'utf8');",
            "        fs.appendFileSync(ledger, process.env.TEST_CONCURRENT_LINE + '\\n', 'utf8');",
            '    }',
            '    return out;',
            '};',
        ].join('\n') + '\n', 'utf8');
        const concurrent = JSON.stringify({ at: new Date().toISOString(), target: 'local_OTHER', messageId: 'MSG_TEST_CONCURRENT', delivery: 'queued', sha256: '', probe: 'appended by another session' });
        const r = spawnSync(process.execPath, ['-r', preload, HOOK], {
            input: JSON.stringify(payload(queuedText)),
            encoding: 'utf8',
            env: Object.assign({}, process.env, { AUTODEV_PEER_LEDGER: ledger, TEST_CONCURRENT_LINE: concurrent, TEST_LOCK_SEEN: lockSeen }),
        });
        const res = { code: r.status, out: r.stdout || '', err: r.stderr || '' };
        const got = rows(ledger) || [];
        const seen = fs.existsSync(lockSeen) ? fs.readFileSync(lockSeen, 'utf8') : '(the prune never wrote a new file)';
        check('fixture: the concurrent append fired during the prune', fs.existsSync(lockSeen), seen);
        check('a line appended by another session during the prune survives the rename', silent(res) && got.some((g) => g.messageId === 'MSG_TEST_CONCURRENT'), detail(res) + ' ' + JSON.stringify(got.map((g) => g.messageId)));
        check('  the prune still dropped the old lines and kept the send', got.every((g) => g.target !== 'local_OLD') && got.some((g) => g.messageId === 'MSG_TEST_Q1'), JSON.stringify(got.map((g) => g.messageId)));
        check('  the rewrite ran while holding the lock', seen === 'held', seen);
    }
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
