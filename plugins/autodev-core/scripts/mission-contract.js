#!/usr/bin/env node
'use strict';
/**
 * mission-contract.js — turn one prd.json story into the immutable admit payload
 * that mission-store.js records (backlog item B05: the story/acceptance snapshot).
 *
 * WHY. Brain's procedure says: before dispatch, record story, repository, base
 * SHA, owned paths and acceptance. Written into a chat or a worktree, that
 * record dies with the session. This builds it deterministically from the story
 * and the repository so the store can hold it: the same story at the same base
 * yields byte-identical output, and a changed acceptance criterion yields a
 * different contract, which the store refuses under the original eventId
 * (`event-conflict`). That is the compare-before-write property the audit asked
 * for, with no second schema to keep in step.
 *
 * WHAT IT DOES NOT DO. It never opens the store, starts a worker, or judges the
 * criterion's quality (check-spec-output.js does that). It refuses stories an
 * agent may not act on — done, deferred, needs-setup — rather than admitting
 * them; the five-state contract is prd-states.js's, not a boolean.
 *
 * Usage:
 *   node mission-contract.js --prd prd.json --story S26-001 --paths src/tooltip/ \
 *       [--root <repo>] [--effects read,write] [--target local:<identifier>] \
 *       [--max-attempts 3] [--backoff-ms 60000] [--max-backoff-ms 1800000] \
 *       [--repo-id <id>] [--mission-id <id>] [--event-id <id>]
 *     | node mission-store.js admit --store /absolute/private/dir
 *
 * Output: the admit payload {missionId, eventId, contract} on stdout, exit 0
 * (unwrapped, so it pipes straight into admit); or
 * {"ok":false,"error":{"code","message"}} on stdout, exit 1.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { storiesOf, isActionable } = require('./prd-states.js');

const USAGE = [
    'Usage: node mission-contract.js --prd <prd.json> --story <id> --paths <a,b,..>',
    '         [--root <repo dir, default cwd>] [--effects read,write]',
    '         [--target <local|preview|production>:<identifier>]',
    '         [--max-attempts 3] [--backoff-ms 60000] [--max-backoff-ms 1800000]',
    '         [--repo-id <id>] [--mission-id <id>] [--event-id <id>]',
    'Prints the mission-store.js admit payload {missionId, eventId, contract} for one',
    'story: its acceptance criterion (the story\'s notes, whitespace-normalised), the',
    'repository\'s verified root, common git dir and HEAD as base, the paths the worker',
    'may change, the authorised effects, the target and the retry budget.',
    'Deterministic: same story, same base, same flags give the same bytes. Defaults:',
    'missionId = story id, eventId = admit:<story id>, repo id = origin URL or basename.',
    'Refuses done, deferred and needs-setup stories (story-not-actionable).',
].join('\n') + '\n';

const WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EFFECTS = ['read', 'write', 'commit', 'publish', 'deploy'];
const TARGETS = ['local', 'preview', 'production'];

function fail(code, message) { const e = new Error(message || code); e.publicCode = code; throw e; }

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h' || a === 'help') { out.help = true; continue; }
        if (!a.startsWith('--')) fail('usage', `unexpected argument ${JSON.stringify(a)}`);
        const eq = a.indexOf('=');
        const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
        const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (value === undefined) fail('usage', `--${key} needs a value`);
        if (Object.prototype.hasOwnProperty.call(out, key)) fail('usage', `--${key} given twice`);
        out[key] = value;
    }
    const known = ['help', 'prd', 'story', 'paths', 'root', 'effects', 'target', 'max-attempts', 'backoff-ms', 'max-backoff-ms', 'repo-id', 'mission-id', 'event-id'];
    for (const k of Object.keys(out)) if (!known.includes(k)) fail('usage', `unknown flag --${k}`);
    return out;
}

function relativePath(s) {
    return typeof s === 'string' && s.trim().length > 0 && s.length <= 2048 && !/[\x00-\x1f\x7f]/.test(s)
        && !s.includes('\\') && !s.startsWith('/') && !s.includes(':')
        && s.split('/').every((part, i, all) => part === '' ? i === all.length - 1 : !['.', '..', '.git'].includes(part));
}

function integer(raw, fallback, name, min, max) {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) fail('invalid-retry', `--${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
    return n;
}

function build(opts) {
    for (const required of ['prd', 'story', 'paths']) if (!opts[required]) fail('usage', `--${required} is required`);
    const storyId = opts.story;
    if (!WORD.test(storyId)) fail('story-id-invalid', `story id ${JSON.stringify(storyId)} is not a mission word (letters, digits, . _ : -; up to 128 chars)`);

    const prdPath = path.resolve(opts.prd);
    let prd;
    try { prd = JSON.parse(fs.readFileSync(prdPath, 'utf8')); }
    catch (e) { fail('prd-unreadable', `${prdPath}: ${e.code || e.name}`); }
    const stories = storiesOf(prd);
    if (!Object.prototype.hasOwnProperty.call(stories, storyId)) fail('story-missing', `no story ${JSON.stringify(storyId)} in ${prdPath} (${Object.keys(stories).length} stories read)`);
    const story = stories[storyId];
    if (!story || typeof story !== 'object' || Array.isArray(story)) fail('story-malformed', `story ${storyId} is not an object`);
    if (!isActionable(story)) fail('story-not-actionable', `story ${storyId} has passes=${JSON.stringify(story.passes)}; only pending (null or absent) and failed (false) stories can be admitted`);

    // The acceptance criterion lives in `notes` (check-spec-output.js reads the
    // same field). Whitespace is normalised so a re-wrapped criterion is the
    // same criterion; anything longer than the store accepts is refused rather
    // than truncated, because a truncated snapshot is a different contract.
    const raw = typeof story.notes === 'string' ? story.notes : '';
    const criterion = raw.replace(/\s+/g, ' ').trim();
    if (!criterion) fail('no-acceptance-criterion', `story ${storyId} has no acceptance criterion in notes`);
    if (criterion.length > 2048) fail('acceptance-too-long', `story ${storyId}: criterion is ${criterion.length} characters; the store accepts 2048`);
    if (/[\x00-\x1f\x7f]/.test(criterion)) fail('acceptance-invalid', `story ${storyId}: criterion contains control characters`);

    const rootArg = path.resolve(opts.root || process.cwd());
    const git = (...args) => execFileSync('git', ['-C', rootArg, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let root, commonDir, baseSha;
    try {
        root = fs.realpathSync(git('rev-parse', '--show-toplevel'));
        commonDir = fs.realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
        baseSha = git('rev-parse', 'HEAD');
    } catch { fail('repo-unverified', `${rootArg} is not a git working tree with a HEAD commit`); }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha)) fail('repo-unverified', `HEAD of ${root} is not a commit sha`);

    let repoId = opts['repo-id'];
    if (repoId === undefined) { try { repoId = git('remote', 'get-url', 'origin'); } catch { repoId = ''; } }
    if (!repoId) repoId = path.basename(root);
    if (!repoId.trim() || repoId.length > 2048 || /[\x00-\x1f\x7f]/.test(repoId)) fail('invalid-repo-id', 'repo id must be non-empty text without control characters');

    const paths = String(opts.paths).split(',').map((s) => s.trim()).filter(Boolean);
    if (!paths.length) fail('invalid-paths', '--paths needs at least one repository-relative path');
    if (paths.length > 1000) fail('invalid-paths', `--paths lists ${paths.length} entries; the store accepts 1000`);
    for (const p of paths) if (!relativePath(p)) fail('invalid-paths', `${JSON.stringify(p)} is not a repository-relative path (no leading /, no \\, no :, no . or .. or .git segments)`);
    if (new Set(paths).size !== paths.length) fail('invalid-paths', '--paths repeats an entry');

    const effects = String(opts.effects === undefined ? 'read,write' : opts.effects).split(',').map((s) => s.trim()).filter(Boolean);
    if (!effects.length) fail('invalid-effects', '--effects needs at least one of ' + EFFECTS.join(', '));
    for (const e of effects) if (!EFFECTS.includes(e)) fail('invalid-effects', `${JSON.stringify(e)} is not one of ${EFFECTS.join(', ')}`);
    if (new Set(effects).size !== effects.length) fail('invalid-effects', '--effects repeats an entry');

    const targetRaw = opts.target === undefined ? `local:${repoId}` : opts.target;
    const colon = targetRaw.indexOf(':');
    const kind = colon > 0 ? targetRaw.slice(0, colon) : '';
    const identifier = colon > 0 ? targetRaw.slice(colon + 1) : '';
    if (!TARGETS.includes(kind)) fail('invalid-target', `--target must be <${TARGETS.join('|')}>:<identifier>, got ${JSON.stringify(targetRaw)}`);
    if (!identifier.trim() || identifier.length > 2048 || /[\x00-\x1f\x7f]/.test(identifier)) fail('invalid-target', 'target identifier must be non-empty text without control characters');

    const retry = {
        maxAttempts: integer(opts['max-attempts'], 3, 'max-attempts', 1, 100),
        backoffMs: integer(opts['backoff-ms'], 60000, 'backoff-ms', 1, 86400000),
        maxBackoffMs: integer(opts['max-backoff-ms'], 1800000, 'max-backoff-ms', 1, 86400000),
    };
    if (retry.maxBackoffMs < retry.backoffMs) fail('invalid-retry', '--max-backoff-ms must be at least --backoff-ms');

    const missionId = opts['mission-id'] === undefined ? storyId : opts['mission-id'];
    const eventId = opts['event-id'] === undefined ? 'admit:' + storyId : opts['event-id'];
    if (!WORD.test(missionId)) fail('invalid-mission-id', `mission id ${JSON.stringify(missionId)} is not a mission word`);
    if (!WORD.test(eventId)) fail('invalid-event-id', `event id ${JSON.stringify(eventId)} is not a mission word`);

    return {
        missionId,
        eventId,
        contract: {
            repo: { id: repoId, root, commonDir, baseSha },
            scope: { paths, effects },
            target: { kind, identifier },
            acceptance: [{ id: storyId, description: criterion }],
            retry,
        },
    };
}

module.exports = { build, parseArgs };

if (require.main === module) {
    try {
        const opts = parseArgs(process.argv.slice(2));
        if (opts.help || process.argv.length === 2) { process.stdout.write(USAGE); }
        else process.stdout.write(JSON.stringify(build(opts)) + '\n');
    } catch (e) {
        const code = e.publicCode || 'error';
        process.stdout.write(JSON.stringify({ ok: false, error: { code, message: e.publicCode ? e.message : code } }) + '\n');
        process.exitCode = 1;
    }
}
