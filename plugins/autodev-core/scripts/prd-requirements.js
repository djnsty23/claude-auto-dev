#!/usr/bin/env node
'use strict';
// One interpretation of story requirements for planning, admission and review.
// This reader never updates a revision or a completion state on the user's behalf.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { storiesOf, dependencyProblems } = require('./prd-states.js');

const WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SPEC_BYTES = 65536;
const MAX_SNAPSHOT_BYTES = 131072;
function fail(code, message) { const e = new Error(message); e.publicCode = code; throw e; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function relativeFile(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 2048
        && !/[\x00-\x1f\x7f\\:]/.test(value) && !value.startsWith('/')
        && value.split('/').every(part => part && !['.', '..', '.git'].includes(part));
}
function description(raw, field) {
    if (typeof raw !== 'string') fail(field + '-invalid', `${field} must contain text`);
    const value = raw.replace(/\s+/g, ' ').trim();
    if (!value) fail(field === 'acceptance' ? 'no-acceptance-criterion' : field + '-invalid', `${field} must not be empty`);
    if (value.length > 2048) fail(field + '-too-long', `${field} exceeds 2048 characters`);
    if (/[\x00-\x1f\x7f]/.test(value)) fail(field + '-invalid', `${field} contains control characters`);
    return value;
}
function criteria(raw, field) {
    if (!Array.isArray(raw) || raw.length > 1000 || (field === 'acceptance' && !raw.length)) fail(field + '-invalid', `${field} must be an array${field === 'acceptance' ? ' with at least one criterion' : ''}`);
    const result = raw.map(item => {
        if (typeof item === 'string') {
            const text = description(item, field);
            return { id: (field === 'acceptance' ? 'a:' : 'v:') + digest(text), description: text };
        }
        if (!object(item) || Object.keys(item).sort().join(',') !== 'description,id' || !WORD.test(item.id)) fail(field + '-invalid', `${field} entries must be strings or {id, description}`);
        return { id: item.id, description: description(item.description, field) };
    });
    if (new Set(result.map(item => item.id)).size !== result.length) fail(field + '-invalid', `${field} repeats a criterion id`);
    return result;
}
function references(raw) {
    if (!Array.isArray(raw) || raw.length > 100) fail('spec-reference-invalid', 'specRefs must be an array of at most 100 {path, revision} references');
    const result = raw.map(ref => {
        if (!object(ref) || !relativeFile(ref.path) || Object.keys(ref).some(key => !['path', 'revision'].includes(key))) fail('spec-reference-invalid', 'spec reference must name a repository-relative file');
        if (typeof ref.revision !== 'string' || !HASH.test(ref.revision)) fail('spec-revision-mismatch', `spec ${ref.path} needs its reviewed SHA-256 revision`);
        return { path: ref.path, revision: ref.revision };
    });
    if (new Set(result.map(ref => ref.path)).size !== result.length) fail('spec-reference-invalid', 'specRefs repeats a path');
    return result;
}
function readSpec(root, ref) {
    let fd;
    try {
        const base = fs.realpathSync.native(root);
        const resolved = fs.realpathSync.native(path.resolve(base, ref.path));
        const relative = path.relative(base, resolved);
        if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) fail('spec-reference-invalid', `spec ${ref.path} escapes the repository`);
        fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) fail('spec-reference-invalid', `spec ${ref.path} must be a regular file of at most ${MAX_SPEC_BYTES} bytes`);
        // Bounded read even when a concurrent writer grows the file after fstat.
        const bytes = Buffer.alloc(MAX_SPEC_BYTES + 1);
        let length = 0, count;
        while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
        if (length > MAX_SPEC_BYTES) fail('spec-reference-invalid', `spec ${ref.path} grew beyond the size bound`);
        const data = bytes.subarray(0, length);
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
        if (!content.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) fail('spec-reference-invalid', `spec ${ref.path} must contain plain UTF-8 text`);
        return { path: ref.path, revision: digest(data), content };
    } catch (e) {
        if (e.publicCode) throw e;
        fail('spec-unreadable', `spec ${ref.path} could not be read as UTF-8 (${e.code || e.name})`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readRequirements(story, storyId, root) {
    if (!object(story)) fail('story-malformed', `story ${storyId} must be an object`);
    const acceptance = story.acceptance === undefined
        ? [{ id: storyId, description: description(story.notes === undefined ? '' : story.notes, 'acceptance') }]
        : criteria(story.acceptance, 'acceptance');
    const result = { acceptance };
    if (story.verify !== undefined) result.verification = criteria(story.verify, 'verification');
    if (story.specRefs !== undefined) result.specRefs = references(story.specRefs).map(ref => {
        const snapshot = readSpec(root, ref);
        if (snapshot.revision !== ref.revision) fail('spec-revision-mismatch', `spec ${ref.path} changed since this story was planned; reconcile its criteria before recording revision ${snapshot.revision}`);
        return snapshot;
    });
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_SNAPSHOT_BYTES) fail('requirements-too-large', 'requirements snapshot exceeds 128 KiB; split the ticket');
    return result;
}

// Store input is a frozen snapshot, not permission to re-read arbitrary paths.
function validateSnapshot(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length > 100) fail('invalid-contract', 'invalid spec snapshots');
    references(snapshot.map(ref => object(ref) ? { path: ref.path, revision: ref.revision } : ref));
    for (const ref of snapshot) {
        if (Object.keys(ref).sort().join(',') !== 'content,path,revision' || typeof ref.content !== 'string'
            || !ref.content.trim() || Buffer.byteLength(ref.content) > MAX_SPEC_BYTES
            || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(ref.content) || digest(ref.content) !== ref.revision) fail('invalid-contract', 'spec content does not match its revision');
    }
}

function revisionReport(prd, root) {
    const stories = storiesOf(prd), entries = Object.entries(stories);
    if (!entries.length) fail('no-stories', 'zero stories; no revision coverage');
    const graph = dependencyProblems(prd);
    if (graph.length) fail('dependencies-invalid', graph.map(item => `${item.id}: ${item.reason}`).join('; '));
    const stale = [];
    for (const [id, story] of entries) {
        if (!object(story)) fail('story-malformed', `story ${id} must be an object`);
        for (const ref of references(story.specRefs === undefined ? [] : story.specRefs)) {
            let current;
            try { current = readSpec(root, ref); }
            catch (e) {
                if (!e.publicCode) throw e;
                stale.push({ id, path: ref.path, expectedRevision: ref.revision, actualRevision: null, reason: e.publicCode });
                continue;
            }
            if (current.revision !== ref.revision) stale.push({ id, path: ref.path, expectedRevision: ref.revision, actualRevision: current.revision, reason: 'spec-revision-mismatch' });
        }
    }
    const affected = new Set(stale.map(item => item.id));
    // Reverse edges carry an edited requirement's impact to dependent tickets.
    // Completed dependents are included for review; their passes values are untouched.
    const dependents = new Map();
    for (const [id, story] of entries) {
        if (story.blockedBy !== undefined && (!Array.isArray(story.blockedBy) || story.blockedBy.some(dep => typeof dep !== 'string' || !dep.trim()))) fail('dependencies-invalid', `story ${id} has malformed blockedBy`);
        for (const dep of story.blockedBy || []) {
            if (!dependents.has(dep)) dependents.set(dep, []);
            dependents.get(dep).push(id);
        }
    }
    const queue = [...affected];
    for (let i = 0; i < queue.length; i++) for (const id of dependents.get(queue[i]) || []) if (!affected.has(id)) { affected.add(id); queue.push(id); }
    return { stories: entries.length, stale, affected: [...affected].sort(), unchanged: entries.map(([id]) => id).filter(id => !affected.has(id)).sort() };
}

module.exports = { readRequirements, revisionReport, validateSnapshot };
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (!args.length || args.includes('--help') || args.includes('-h')) {
            process.stdout.write('Usage: node prd-requirements.js revisions --prd <prd.json> --root <repo>\nRead-only revision report: exit 0 unchanged, 1 affected stories, 2 invalid/unreadable.\n');
        } else {
            if (args[0] !== 'revisions' || args.length !== 5) fail('usage', 'expected revisions --prd <prd.json> --root <repo>');
            const opts = {};
            for (let i = 1; i < args.length; i += 2) {
                if (!['--prd', '--root'].includes(args[i]) || opts[args[i]]) fail('usage', 'expected one --prd and one --root');
                opts[args[i]] = args[i + 1];
            }
            const result = revisionReport(JSON.parse(fs.readFileSync(opts['--prd'], 'utf8')), opts['--root']);
            process.stdout.write(JSON.stringify(result) + '\n');
            process.exitCode = result.stale.length ? 1 : 0;
        }
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: { code: e.publicCode || 'requirements-unreadable', message: e.publicCode ? e.message : 'Could not read requirements' } }) + '\n');
        process.exitCode = 2;
    }
}
