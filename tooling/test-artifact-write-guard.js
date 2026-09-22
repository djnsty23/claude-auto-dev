#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/hooks/artifact-write-guard.js.
//
// The hook validates ArtifactData writes against a private schema file and
// refuses the ones that break it. Driven as a subprocess, the way it runs, with
// a temp schema directory passed through AUTODEV_ARTIFACT_SCHEMA_DIR so no case
// can read a real schema from the machine running the suite.
//
// Every rule has a refusal case AND a control that passes, so a hook that
// refused everything fails here as surely as one that refused nothing. Silence
// is asserted on BOTH streams: a hook with nothing to say must emit zero bytes.
//
// Run: node tooling/test-artifact-write-guard.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'artifact-write-guard.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail !== undefined ? '  (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-guard-'));
const SCHEMAS = path.join(TMP, 'schemas');
const EMPTY = path.join(TMP, 'empty');
fs.mkdirSync(SCHEMAS, { recursive: true });
fs.mkdirSync(EMPTY, { recursive: true });

const ID = 'ART_TEST_1';
const URL_FOR = (id) => 'https://example.invalid/artifacts/' + id;
const SCHEMA_FILE = path.join(SCHEMAS, ID + '.json');

fs.writeFileSync(SCHEMA_FILE, JSON.stringify({
    futureToleranceSeconds: 120,
    collections: {
        tasks: {
            fields: {
                title: { type: 'string' },
                status: { type: 'string', enum: ['todo', 'doing', 'done'] },
                owner: { type: 'string', notEnum: ['unassigned'] },
                updatedAt: { type: 'timestamp' },
                count: { type: 'number' },
                tags: { type: 'array' },
                meta: { type: 'object' },
                'results.*.state': { enum: ['pass', 'fail'] },
            },
            requiredOnSet: ['title'],
            requiredOnWrite: ['updatedAt'],
            unknownFields: 'deny',
        },
        archive: {
            fields: { note: { type: 'string' } },
            noDelete: true,
        },
        loose: {
            fields: { stamp: { type: 'timestamp' } },
        },
    },
}), 'utf8');

// A second artifact whose schema is not JSON: the hook must fail OPEN.
fs.writeFileSync(path.join(SCHEMAS, 'ART_TEST_CORRUPT.json'), '{ "collections": { this is not json', 'utf8');

function run(input, schemaDir) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ tool_name: 'ArtifactData', tool_input: input }),
        encoding: 'utf8',
        env: Object.assign({}, process.env, { AUTODEV_ARTIFACT_SCHEMA_DIR: schemaDir || SCHEMAS }),
    });
    const out = r.stdout || '';
    let json = null;
    try { json = JSON.parse(out); } catch { json = null; }
    const hso = json && json.hookSpecificOutput;
    const denied = !!hso && hso.hookEventName === 'PreToolUse' && hso.permissionDecision === 'deny';
    return { code: r.status, out, err: r.stderr || '', denied, reason: denied ? String(hso.permissionDecisionReason || '') : '' };
}

const silent = (r) => r.code === 0 && r.out === '' && r.err === '';
const detail = (r) => 'exit ' + r.code + ', stdout ' + JSON.stringify(r.out.slice(0, 160)) + ', stderr ' + JSON.stringify(r.err.slice(0, 80));
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

const validTask = () => ({ title: 'write the suite', status: 'doing', owner: 'agent', updatedAt: iso(-1000), count: 2, tags: ['a'], meta: { k: 1 } });

try {
    // ---- no schema: zero bytes, whatever the write ---------------------------
    {
        const bad = { action: 'set', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { status: 'nonsense' } };
        const r = run(bad, EMPTY);
        check('no schema file: a write passes with zero stdout and zero stderr', silent(r), detail(r));
        const other = run(Object.assign({}, bad, { url: URL_FOR('ART_TEST_NO_SCHEMA') }));
        check('no schema file for THIS artifact: zero bytes', silent(other), detail(other));
    }

    // ---- valid writes: zero bytes ----------------------------------------------
    {
        const set = run({ action: 'set', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: validTask() });
        check('a valid set is silent', silent(set), detail(set));
        const upd = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { status: 'done', updatedAt: iso(0) } });
        check('a valid update is silent, and does not demand requiredOnSet', silent(upd), detail(upd));
        const batch = run({
            action: 'batch', url: URL_FOR(ID), writes: [
                { op: 'set', collection: 'tasks', doc_id: 't2', data: validTask() },
                { op: 'update', collection: 'tasks', doc_id: 't1', data: { owner: 'someone', updatedAt: iso(0) } },
                { op: 'delete', collection: 'tasks', doc_id: 't3' },
            ],
        });
        check('a valid batch is silent', silent(batch), detail(batch));
        const withQuery = run({ action: 'set', url: URL_FOR(ID) + '?tab=1#x', collection: 'tasks', doc_id: 't1', data: { status: 'nonsense', title: 'x', updatedAt: iso(0) } });
        check('the artifact id survives a query string and a fragment in the url', withQuery.denied, detail(withQuery));
    }

    // ---- enum and notEnum ------------------------------------------------------
    {
        const r = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { status: 'finished', updatedAt: iso(0) } });
        check('a value outside the enum is DENIED', r.denied, detail(r));
        check('  the reason names the collection and doc id', r.reason.startsWith('artifact-write-guard: tasks/t1: '), r.reason);
        check('  the reason names the field, the value and the allowed set', /status: "finished" is not one of \["todo", "doing", "done"\]/.test(r.reason), r.reason);
        check('  the reason ends with the schema path', r.reason.endsWith('. Schema: ' + SCHEMA_FILE), r.reason);
        check('  a refusal exits 0 and prints nothing on stderr', r.code === 0 && r.err === '', detail(r));
        check('  stdout is exactly one JSON object', (() => { try { JSON.parse(r.out); return r.out.trim().startsWith('{') && r.out.trim().endsWith('}'); } catch { return false; } })(), r.out.slice(0, 80));
    }
    {
        const r = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { owner: 'unassigned', updatedAt: iso(0) } });
        check('a value listed in notEnum is DENIED', r.denied && /owner: "unassigned" is not allowed/.test(r.reason), detail(r));
        const ok = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { owner: 'assigned', updatedAt: iso(0) } });
        check('  CONTROL: a value not in notEnum passes', silent(ok), detail(ok));
    }

    // ---- required fields -------------------------------------------------------
    {
        const data = validTask(); delete data.title;
        const r = run({ action: 'set', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data });
        check('a set missing a requiredOnSet field is DENIED', r.denied && /missing required field title/.test(r.reason), detail(r));
        const data2 = validTask(); delete data2.updatedAt;
        const r2 = run({ action: 'set', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: data2 });
        check('a set missing a requiredOnWrite field is DENIED', r2.denied && /missing required field updatedAt/.test(r2.reason), detail(r2));
        const r3 = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { status: 'done' } });
        check('an update missing a requiredOnWrite field is DENIED', r3.denied && /missing required field updatedAt/.test(r3.reason), detail(r3));
    }

    // ---- every violation is reported, not only the first -----------------------
    {
        const r = run({ action: 'set', url: URL_FOR(ID), collection: 'tasks', doc_id: 't9', data: { status: 'x', owner: 'unassigned', updatedAt: iso(0) } });
        const parts = r.reason.replace(/\. Schema: .*$/, '').split(': ').slice(1).join(': ').split('; ');
        check('every violation is listed, joined with "; "', r.denied && parts.length === 3, r.reason);
    }

    // ---- timestamps ------------------------------------------------------------
    {
        const r = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: iso(3600 * 1000) } });
        check('a timestamp an hour ahead of the clock is DENIED', r.denied && /updatedAt: .* s ahead of now/.test(r.reason), detail(r));
        check('  the reason carries the current UTC time so the writer can fix it', /now \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z UTC\)/.test(r.reason), r.reason);
        const near = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: iso(60 * 1000) } });
        check('  CONTROL: a timestamp 60 s ahead passes inside the 120 s tolerance', silent(near), detail(near));
        const offset = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: '2020-01-01T10:00:00+02:00' } });
        check('  an offset timestamp in the past passes', silent(offset), detail(offset));
        const noZone = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: '2020-01-01T10:00:00' } });
        check('a timestamp with no Z or offset is DENIED', noZone.denied && /not an ISO 8601 timestamp/.test(noZone.reason), detail(noZone));
        const words = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: 'yesterday' } });
        check('a timestamp that is not a date at all is DENIED', words.denied, detail(words));
        const num = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: Date.now() } });
        check('an epoch number where a timestamp belongs is DENIED', num.denied && /expected timestamp, got number/.test(num.reason), detail(num));
    }

    // ---- types -----------------------------------------------------------------
    {
        const r = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { count: '2', tags: 'a', meta: [], title: 7, updatedAt: iso(0) } });
        check('wrong types are DENIED, one violation per field',
            r.denied && /count: expected number, got string/.test(r.reason) && /tags: expected array, got string/.test(r.reason)
            && /meta: expected object, got array/.test(r.reason) && /title: expected string, got number/.test(r.reason), detail(r));
    }

    // ---- wildcard paths --------------------------------------------------------
    {
        const r = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: iso(0), results: { r1: { state: 'pass' }, r2: { state: 'flaky' } } } });
        check('a wildcard path is checked on every child', r.denied && /results\.r2\.state: "flaky" is not one of/.test(r.reason) && !/results\.r1/.test(r.reason), detail(r));
        const ok = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: iso(0), results: { r1: { state: 'pass' }, r2: { state: 'fail' } } } });
        check('  CONTROL: valid children under the wildcard pass', silent(ok), detail(ok));
        const arr = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: iso(0), results: [{ state: 'pass' }, { state: 'nope' }] } });
        check('  a wildcard expands over array indices too', arr.denied && /results\.1\.state/.test(arr.reason), detail(arr));
    }

    // ---- unknown fields --------------------------------------------------------
    {
        const r = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: iso(0), stauts: 'done', results: { r1: { state: 'pass', extra: 1 } } } });
        check('unknownFields deny refuses a misspelled field', r.denied && /unknown field stauts/.test(r.reason), detail(r));
        check('  and a field under a wildcard that no path names', /unknown field results\.r1\.extra/.test(r.reason), r.reason);
        const inside = run({ action: 'update', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', data: { updatedAt: iso(0), meta: { anything: { goes: true } } } });
        check('  CONTROL: a declared object field covers its own subtree', silent(inside), detail(inside));
        const loose = run({ action: 'set', url: URL_FOR(ID), collection: 'loose', doc_id: 'l1', data: { whatever: 1 } });
        check('  CONTROL: a collection without unknownFields deny allows extra fields', silent(loose), detail(loose));
    }

    // ---- batch -----------------------------------------------------------------
    {
        const r = run({
            action: 'batch', url: URL_FOR(ID), writes: [
                { op: 'set', collection: 'tasks', doc_id: 'b1', data: validTask() },
                { op: 'update', collection: 'tasks', doc_id: 'b2', data: { status: 'lost', updatedAt: iso(0) } },
                { op: 'set', collection: 'untracked', doc_id: 'b3', data: { anything: true } },
            ],
        });
        check('a batch with one bad entry is DENIED', r.denied, detail(r));
        // Match the entries by collection/doc_id. A bare /b1|b3/ also matched the random mkdtemp suffix inside the
        // schema path this reason ends with (measured: "artifact-guard-s4b1aX"), so the case failed at random.
        check('  the reason names only the bad entry', /tasks\/b2: status: "lost"/.test(r.reason) && !/tasks\/b1\b|untracked\/b3\b/.test(r.reason), r.reason);
        const two = run({
            action: 'batch', url: URL_FOR(ID), writes: [
                { op: 'update', collection: 'tasks', doc_id: 'b4', data: { status: 'lost', updatedAt: iso(0) } },
                { op: 'delete', collection: 'archive', doc_id: 'b5' },
            ],
        });
        check('  a batch with two bad entries names both', two.denied && /tasks\/b4/.test(two.reason) && /archive\/b5: delete is not allowed/.test(two.reason), two.reason);
    }

    // ---- str_replace -----------------------------------------------------------
    {
        const r = run({ action: 'str_replace', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', field: 'status', old_str: 'doing', new_str: 'done' });
        check('str_replace on an enum field is DENIED, pointing at update', r.denied && /status: str_replace .* use update/.test(r.reason), detail(r));
        const ts = run({ action: 'str_replace', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', field: 'updatedAt', old_str: '2020', new_str: '2030' });
        check('str_replace on a timestamp field is DENIED', ts.denied && /updatedAt: str_replace .* timestamp, use update/.test(ts.reason), detail(ts));
        const ok = run({ action: 'str_replace', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1', field: 'title', old_str: 'a', new_str: 'b' });
        check('  CONTROL: str_replace on a plain string field passes', silent(ok), detail(ok));
    }

    // ---- delete ----------------------------------------------------------------
    {
        const r = run({ action: 'delete', url: URL_FOR(ID), collection: 'archive', doc_id: 'a1' });
        check('delete on a noDelete collection is DENIED', r.denied && /archive\/a1: delete is not allowed/.test(r.reason), detail(r));
        const ok = run({ action: 'delete', url: URL_FOR(ID), collection: 'tasks', doc_id: 't1' });
        check('  CONTROL: delete on a collection without noDelete passes', silent(ok), detail(ok));
    }

    // ---- reads and other tools -------------------------------------------------
    {
        for (const action of ['get', 'list', 'query']) {
            const r = run({ action, url: URL_FOR(ID), collection: 'archive', doc_id: 'a1', data: { status: 'nonsense' } });
            check('a ' + action + ' is never inspected', silent(r), detail(r));
        }
        const other = spawnSync(process.execPath, [HOOK], {
            input: JSON.stringify({ tool_name: 'Write', tool_input: { action: 'delete', url: URL_FOR(ID), collection: 'archive', doc_id: 'a1' } }),
            encoding: 'utf8', env: Object.assign({}, process.env, { AUTODEV_ARTIFACT_SCHEMA_DIR: SCHEMAS }),
        });
        check('a different tool name is ignored with zero bytes', other.status === 0 && other.stdout === '' && other.stderr === '');
        const untracked = run({ action: 'set', url: URL_FOR(ID), collection: 'not-in-schema', doc_id: 'x', data: { status: 'nonsense' } });
        check('a collection the schema does not name passes', silent(untracked), detail(untracked));
    }

    // ---- ids that are not looked up ------------------------------------------
    {
        fs.writeFileSync(path.join(TMP, 'escape.json'), fs.readFileSync(SCHEMA_FILE));
        const r = run({ action: 'delete', url: 'https://example.invalid/artifacts/..%2Fescape', collection: 'archive', doc_id: 'a1' });
        check('an id outside [A-Za-z0-9_-] is not looked up', silent(r), detail(r));
        const noUrl = run({ action: 'delete', collection: 'archive', doc_id: 'a1' });
        check('a call with no url passes', silent(noUrl), detail(noUrl));
    }

    // ---- fail open -------------------------------------------------------------
    {
        const r = run({ action: 'delete', url: URL_FOR('ART_TEST_CORRUPT'), collection: 'archive', doc_id: 'a1' });
        check('a corrupt schema fails OPEN with zero bytes', silent(r), detail(r));
        const garbage = spawnSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8', env: Object.assign({}, process.env, { AUTODEV_ARTIFACT_SCHEMA_DIR: SCHEMAS }) });
        check('garbage stdin fails OPEN with zero bytes', garbage.status === 0 && garbage.stdout === '' && garbage.stderr === '');
        const weird = run({ action: 'batch', url: URL_FOR(ID), writes: 'not an array' });
        check('a batch whose writes is not an array fails OPEN', silent(weird), detail(weird));
    }

    // ---- file_path -------------------------------------------------------------
    {
        const bad = path.join(TMP, 'bad-doc.json');
        fs.writeFileSync(bad, JSON.stringify({ title: 't', status: 'wrong', updatedAt: iso(0) }), 'utf8');
        const r = run({ action: 'set', url: URL_FOR(ID), collection: 'tasks', doc_id: 'f1', file_path: bad });
        check('data read from file_path is validated', r.denied && /status: "wrong"/.test(r.reason), detail(r));
        const good = path.join(TMP, 'good-doc.json');
        fs.writeFileSync(good, JSON.stringify(validTask()), 'utf8');
        const ok = run({ action: 'batch', url: URL_FOR(ID), writes: [{ op: 'set', collection: 'tasks', doc_id: 'f2', file_path: good }] });
        check('  CONTROL: a valid file_path document in a batch passes', silent(ok), detail(ok));
        const missing = run({ action: 'set', url: URL_FOR(ID), collection: 'tasks', doc_id: 'f3', file_path: path.join(TMP, 'does-not-exist.json') });
        check('  an unreadable file_path passes (the tool fails on it itself)', silent(missing), detail(missing));
    }

    // ---- a leading byte order mark ---------------------------------------------
    // Windows PowerShell 5.1 saves UTF-8 with a BOM, and JSON.parse throws on
    // U+FEFF. Before the fix a schema saved that way failed open, which turned
    // the guard off in silence, and a file_path document with one passed unread.
    {
        const BOM = '\uFEFF';
        const bomId = 'ART_TEST_BOM';
        const bomSchema = path.join(SCHEMAS, bomId + '.json');
        fs.writeFileSync(bomSchema, BOM + fs.readFileSync(SCHEMA_FILE, 'utf8'), 'utf8');
        const head = fs.readFileSync(bomSchema).subarray(0, 3).toString('hex');
        check('fixture: the BOM schema starts with the bytes ef bb bf', head === 'efbbbf', head);
        const r = run({ action: 'update', url: URL_FOR(bomId), collection: 'tasks', doc_id: 'm1', data: { status: 'finished', updatedAt: iso(0) } });
        check('a schema saved with a BOM still guards: an enum violation is DENIED', r.denied && /status: "finished" is not one of/.test(r.reason), detail(r));
        const ok = run({ action: 'update', url: URL_FOR(bomId), collection: 'tasks', doc_id: 'm1', data: { status: 'done', updatedAt: iso(0) } });
        check('  CONTROL: a valid write against the BOM schema is silent', silent(ok), detail(ok));

        const bomDoc = path.join(TMP, 'bom-doc.json');
        fs.writeFileSync(bomDoc, BOM + JSON.stringify({ title: 't', status: 'wrong', updatedAt: iso(0) }), 'utf8');
        const doc = run({ action: 'set', url: URL_FOR(ID), collection: 'tasks', doc_id: 'm2', file_path: bomDoc });
        check('a file_path document saved with a BOM is validated: DENIED', doc.denied && /tasks\/m2: status: "wrong"/.test(doc.reason), detail(doc));
    }
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
