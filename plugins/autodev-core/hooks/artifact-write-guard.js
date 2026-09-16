#!/usr/bin/env node
'use strict';

// artifact-write-guard.js: validate writes to a shared Artifact database against
// a schema the user keeps privately, before the ArtifactData tool sends them.
//
// WHY. The ArtifactData tool writes shared, durable rows with no validation at
// all. Sessions wrote field names the page never reads, enum values the page
// cannot render, and timestamps ahead of the real clock, which sort a row above
// work that happened later. Every one of those reached every viewer, and the
// writer got a success result each time.
//
// WHAT IT READS. The artifact id is the last non-empty path segment of the
// tool's `url`. The schema lives at
//
//     ${AUTODEV_ARTIFACT_SCHEMA_DIR || ~/.claude/autodev/artifact-schemas}/<id>.json
//
// and only ids matching /^[A-Za-z0-9_-]{1,64}$/ are looked up. No schema file
// means this hook says nothing and allows the call. The schema format:
//
//   {
//     "futureToleranceSeconds": 120,
//     "collections": {
//       "<collection path, exactly as the tool's `collection` field>": {
//         "fields": {
//           "<field path>": {
//             "type": "string|boolean|number|timestamp|object|array",
//             "enum": [ ... ],
//             "notEnum": [ ... ]
//           }
//         },
//         "requiredOnSet": [ "<field path>" ],
//         "requiredOnWrite": [ "<field path>" ],
//         "noDelete": false,
//         "unknownFields": "allow|deny"
//       }
//     }
//   }
//
// A field path uses dots for nesting and `*` for any one key or array index,
// for example `results.*.state`. Every key inside a spec is optional. A
// `timestamp` is a string in ISO 8601 with `Z` or an offset that Date.parse
// accepts, no more than futureToleranceSeconds (default 120) ahead of now.
// Collections the schema does not name pass untouched.
//
// WHICH RULES APPLY TO WHICH ACTION.
//   set          requiredOnSet and requiredOnWrite present, present fields valid
//   update       requiredOnWrite present, present fields valid
//   batch        each entry by its own op
//   delete       refused only when the collection says noDelete
//   str_replace  refused when the target field has an enum or is a timestamp,
//                because a text splice cannot be validated; use update
//   get, list, query   never inspected
// A `file_path` in place of `data` is read and parsed. When it cannot be read,
// the call passes, because the tool fails on it by itself.
//
// IT FAILS OPEN. This ships installed in other people's sessions, so a defect
// here would persist until they reinstall. A corrupt schema, an unexpected
// payload shape or any thrown error allows the write with zero bytes of output.
// A refusal is one JSON object on stdout with permissionDecision "deny", which
// the harness shows to the writer so it can fix the call and retry.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = 'ArtifactData';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TOLERANCE_S = 120;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const TYPES = new Set(['string', 'boolean', 'number', 'timestamp', 'object', 'array']);

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The last non-empty path segment of the artifact URL, or null. */
function artifactId(url) {
    if (typeof url !== 'string' || !url) return null;
    let pathname = url;
    try { pathname = new URL(url).pathname; } catch { pathname = url.split(/[?#]/)[0]; }
    const segs = pathname.split('/').filter(Boolean);
    const id = segs.length ? segs[segs.length - 1] : null;
    return id && ID_RE.test(id) ? id : null;
}

function schemaPathFor(id) {
    const dir = process.env.AUTODEV_ARTIFACT_SCHEMA_DIR
        || path.join(os.homedir(), '.claude', 'autodev', 'artifact-schemas');
    return path.join(dir, id + '.json');
}

/**
 * Every concrete value in `data` addressed by the dotted `pattern`, as
 * [{ at, value }]. A `*` segment expands over object keys and array indices.
 */
function resolvePattern(data, pattern) {
    const segs = String(pattern).split('.');
    let frontier = [{ at: [], value: data }];
    for (const seg of segs) {
        const next = [];
        for (const node of frontier) {
            const v = node.value;
            if (v === null || typeof v !== 'object') continue;
            if (seg === '*') {
                for (const k of Object.keys(v)) next.push({ at: node.at.concat(k), value: v[k] });
            } else if (Object.prototype.hasOwnProperty.call(v, seg)) {
                next.push({ at: node.at.concat(seg), value: v[seg] });
            }
        }
        frontier = next;
    }
    return frontier.map((n) => ({ at: n.at.join('.'), value: n.value }));
}

/**
 * Concrete paths a required pattern demands. Wildcards expand over what exists,
 * so `results.*.state` demands `state` on every child of `results`, and demands
 * nothing when `results` is absent (require `results` itself for that).
 */
function missingRequired(data, pattern) {
    const segs = String(pattern).split('.');
    const parentPattern = segs.slice(0, -1).join('.');
    const last = segs[segs.length - 1];
    const parents = segs.length === 1 ? [{ at: '', value: data }] : resolvePattern(data, parentPattern);
    const missing = [];
    for (const p of parents) {
        const where = p.at ? p.at + '.' : '';
        if (p.value === null || typeof p.value !== 'object') { missing.push(where + last); continue; }
        if (last === '*') continue;
        if (p.value[last] === undefined) missing.push(where + last);
    }
    return missing;
}

function short(v) {
    let s;
    try { s = JSON.stringify(v); } catch { s = String(v); }
    if (s === undefined) s = String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

function listOf(values) {
    const shown = values.slice(0, 10).map(short).join(', ');
    return '[' + shown + (values.length > 10 ? ', ...' : '') + ']';
}

/** Violations for one value against one field spec. */
function checkValue(at, value, spec, toleranceS, nowMs) {
    const out = [];
    const type = spec.type;
    if (type && TYPES.has(type)) {
        let ok;
        if (type === 'number') ok = typeof value === 'number' && Number.isFinite(value);
        else if (type === 'object') ok = isPlainObject(value);
        else if (type === 'array') ok = Array.isArray(value);
        else if (type === 'timestamp') ok = typeof value === 'string';
        else ok = typeof value === type;
        if (!ok) {
            const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
            out.push(at + ': expected ' + type + ', got ' + got);
            return out;
        }
        if (type === 'timestamp') {
            const t = Date.parse(value);
            if (!ISO_RE.test(value) || !Number.isFinite(t)) {
                out.push(at + ': ' + short(value) + ' is not an ISO 8601 timestamp with Z or an offset');
            } else if (t - nowMs > toleranceS * 1000) {
                out.push(at + ': ' + value + ' is ' + Math.round((t - nowMs) / 1000)
                    + ' s ahead of now (' + new Date(nowMs).toISOString() + ' UTC), tolerance '
                    + toleranceS + ' s');
            }
        }
    }
    if (Array.isArray(spec.enum) && !spec.enum.some((e) => e === value)) {
        out.push(at + ': ' + short(value) + ' is not one of ' + listOf(spec.enum));
    }
    if (Array.isArray(spec.notEnum) && spec.notEnum.some((e) => e === value)) {
        out.push(at + ': ' + short(value) + ' is not allowed here');
    }
    return out;
}

/** Concrete paths in `data` that no field pattern covers, when unknownFields is deny. */
function unknownPaths(data, patterns) {
    const split = patterns.map((p) => String(p).split('.'));
    const prefixMatches = (segs, at) => at.every((s, i) => segs[i] === '*' || segs[i] === s);
    const out = [];
    const walk = (value, at) => {
        if (value === null || typeof value !== 'object') return;
        for (const k of Object.keys(value)) {
            const here = at.concat(k);
            const covering = split.filter((segs) => segs.length >= here.length && prefixMatches(segs, here));
            if (!covering.length) { out.push(here.join('.')); continue; }
            if (covering.some((segs) => segs.length > here.length)) walk(value[k], here);
        }
    };
    walk(data, []);
    return out;
}

/** Violations for a set or update of `data` against one collection spec. */
function checkDocument(op, data, coll, toleranceS, nowMs) {
    const out = [];
    const fields = isPlainObject(coll.fields) ? coll.fields : {};
    const required = []
        .concat(op === 'set' && Array.isArray(coll.requiredOnSet) ? coll.requiredOnSet : [])
        .concat(Array.isArray(coll.requiredOnWrite) ? coll.requiredOnWrite : []);
    const seenMissing = new Set();
    for (const r of required) {
        for (const m of missingRequired(data, r)) {
            if (seenMissing.has(m)) continue;
            seenMissing.add(m);
            out.push('missing required field ' + m);
        }
    }
    for (const [pattern, spec] of Object.entries(fields)) {
        if (!isPlainObject(spec)) continue;
        for (const hit of resolvePattern(data, pattern)) {
            out.push(...checkValue(hit.at, hit.value, spec, toleranceS, nowMs));
        }
    }
    if (coll.unknownFields === 'deny') {
        for (const u of unknownPaths(data, Object.keys(fields))) out.push('unknown field ' + u);
    }
    return out;
}

/** The document a write carries: inline data, a readable file_path, or null to pass. */
function writeData(entry) {
    if (isPlainObject(entry.data)) return entry.data;
    if (typeof entry.file_path === 'string' && entry.file_path) {
        try {
            const parsed = JSON.parse(fs.readFileSync(entry.file_path, 'utf8'));
            return isPlainObject(parsed) ? parsed : null;
        } catch { return null; }
    }
    return null;
}

/** Violations for one write (set, update or delete), or [] when it passes. */
function checkWrite(op, entry, schema, nowMs) {
    const collections = schema.collections;
    const coll = typeof entry.collection === 'string' && Object.prototype.hasOwnProperty.call(collections, entry.collection)
        ? collections[entry.collection] : null;
    if (!isPlainObject(coll)) return [];
    const toleranceS = Number.isFinite(schema.futureToleranceSeconds) && schema.futureToleranceSeconds >= 0
        ? schema.futureToleranceSeconds : DEFAULT_TOLERANCE_S;
    if (op === 'delete') return coll.noDelete === true ? ['delete is not allowed on this collection'] : [];
    if (op !== 'set' && op !== 'update') return [];
    const data = writeData(entry);
    if (!data) return [];
    return checkDocument(op, data, coll, toleranceS, nowMs);
}

/** str_replace cannot be validated, so it is refused on fields a splice could corrupt. */
function checkStrReplace(input, schema) {
    const collections = schema.collections;
    const coll = typeof input.collection === 'string' && Object.prototype.hasOwnProperty.call(collections, input.collection)
        ? collections[input.collection] : null;
    if (!isPlainObject(coll) || !isPlainObject(coll.fields) || typeof input.field !== 'string') return [];
    const out = [];
    for (const [pattern, spec] of Object.entries(coll.fields)) {
        if (!isPlainObject(spec) || pattern.includes('.')) continue;
        if (pattern !== '*' && pattern !== input.field) continue;
        if (Array.isArray(spec.enum)) out.push(input.field + ': str_replace cannot be validated against an enum, use update');
        else if (spec.type === 'timestamp') out.push(input.field + ': str_replace cannot be validated on a timestamp, use update');
    }
    return out;
}

function label(entry) {
    return String(entry.collection || '?') + '/' + String(entry.doc_id || '?');
}

/** The deny reason for this call, or null to allow it. */
function evaluate(payload, nowMs) {
    const name = payload && (payload.tool_name || payload.toolName);
    if (name !== TOOL) return null;
    const input = payload.tool_input || payload.toolInput;
    if (!isPlainObject(input)) return null;
    const action = input.action;
    if (!['set', 'update', 'delete', 'str_replace', 'batch'].includes(action)) return null;

    const id = artifactId(input.url);
    if (!id) return null;
    const schemaPath = schemaPathFor(id);
    let raw;
    try { raw = fs.readFileSync(schemaPath, 'utf8'); } catch { return null; }
    const schema = JSON.parse(raw);   // a corrupt schema throws, and main fails open
    if (!isPlainObject(schema) || !isPlainObject(schema.collections)) return null;

    const groups = [];
    if (action === 'batch') {
        if (!Array.isArray(input.writes)) return null;
        for (const entry of input.writes) {
            if (!isPlainObject(entry)) continue;
            const v = checkWrite(entry.op, entry, schema, nowMs);
            if (v.length) groups.push(label(entry) + ': ' + v.join('; '));
        }
    } else if (action === 'str_replace') {
        const v = checkStrReplace(input, schema);
        if (v.length) groups.push(label(input) + ': ' + v.join('; '));
    } else {
        const v = checkWrite(action, input, schema, nowMs);
        if (v.length) groups.push(label(input) + ': ' + v.join('; '));
    }
    if (!groups.length) return null;
    return 'artifact-write-guard: ' + groups.join(' | ') + '. Schema: ' + schemaPath;
}

function main(rawPayload) {
    let payload;
    try { payload = JSON.parse(rawPayload); } catch { return; }
    const reason = evaluate(payload, Date.now());
    if (!reason) return;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
}

if (require.main === module) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => {
        try { main(buf); } catch { /* fails open, always, with zero bytes */ }
        process.exitCode = 0;
    });
    process.stdin.on('error', () => { process.exitCode = 0; });
}

module.exports = { evaluate, artifactId, resolvePattern, missingRequired, unknownPaths, TOOL };
