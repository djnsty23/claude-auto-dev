#!/usr/bin/env node
'use strict';
/**
 * prd-mark-needs-setup.js — move ONE story between `needs-setup` and pending,
 * so a skill never hand-edits prd.json to record a handback.
 *
 * WHY A SCRIPT AND NOT A SENTENCE IN auto/SKILL.md.
 *
 * `[measured 2026-09-07]` `git log -S'needs-setup' -- prd.json` on the trunk of
 * three product repos: 0, 0 and 1 write, against 45, 7 and 23 writes of
 * `deferred`. auto/SKILL.md has told sessions to write `needs-setup` since the
 * state was invented, and `wizard` tells them to write the handback into the
 * chat. Both are prose, and prose produced one write in four months while the
 * stories that ARE blocked on a person sat as `passes: null` — six of the ten
 * pending stories in one client repo, the oldest 122 days. The one time a
 * session did write the state by hand (a greenfield run, 2026-09-07) it put the
 * handback text in a log file and pointed the story at it, so the story alone
 * could not say what it was waiting for.
 *
 * A hand edit to a JSON file is also how archive-prd deleted needs-setup stories
 * and how a nested-sprint file counted zero. One writer, using the shared
 * reader, is the same cure `prd-states.js` was for the five states.
 *
 * WHAT IT WRITES, and what it leaves alone.
 *
 *   passes        -> "needs-setup"          (or back to null with --clear)
 *   blockedReason -> the handback: what is needed, where, what done looks like.
 *                    The name auto/SKILL.md step 6 already used, and the one the
 *                    greenfield session reached for unprompted.
 *   blockedAt     -> the date, so `status` can say how long it has waited.
 *
 * `notes` is NOT touched. In a spec-generated backlog it is the acceptance
 * criterion — the thing `auto` reads to decide whether the story is finished —
 * and a handback that overwrote it would turn "what done looks like" into "what
 * we are waiting for". Two questions, two fields.
 *
 * REFUSALS, each exit 2 with the file unchanged:
 *   - an id that is not in the file (names the population it read)
 *   - a story that is already `true`: done work is not blocked
 *   - a story that is `deferred`: a decision not to do it is not a block on a
 *     person; un-defer it first so the reversal is a step somebody took
 *   - an empty reason: an unexplained block is the invisible kind this exists
 *     to end
 *
 * IDEMPOTENT. Marking a story that is already needs-setup with the same reason
 * writes nothing and exits 0. `auto` may reach the same handback twice in one
 * sprint, and the second call must not churn the file.
 *
 * Usage:
 *   node prd-mark-needs-setup.js <id> "<reason>" [--prd path]
 *   node prd-mark-needs-setup.js <id> --clear      [--prd path]   operator did it
 *   node prd-mark-needs-setup.js --list            [--prd path]
 */

const fs = require('fs');
const path = require('path');
const S = require(path.join(__dirname, 'prd-states.js'));

const HELP = `prd-mark-needs-setup — record that a story is blocked on a person.

  node prd-mark-needs-setup.js <id> "<reason>"   passes -> "needs-setup", reason -> blockedReason
  node prd-mark-needs-setup.js <id> --clear      the operator did it: passes -> null
  node prd-mark-needs-setup.js --list            every story blocked on you, with its reason
  --prd <path>                                   default ./prd.json

Refuses (exit 2, file untouched): unknown id, a story already true, a deferred
story, an empty reason. Marking twice with the same reason is a no-op.
`;

/**
 * The object that HOLDS the story — root `stories` or a sprint's — so the
 * write lands where the read found it. storiesOf() merges every sprint with
 * the later one winning, so the last sprint carrying the id is the one edited.
 */
function locate(prd, id) {
    if (!prd || typeof prd !== 'object') return null;
    let found = null;
    for (const sprint of Array.isArray(prd.sprints) ? prd.sprints : []) {
        const st = sprint && sprint.stories;
        if (st && typeof st === 'object' && Object.prototype.hasOwnProperty.call(st, id)) found = st;
    }
    if (found) return found;
    const root = prd.stories;
    if (root && typeof root === 'object' && Object.prototype.hasOwnProperty.call(root, id)) return root;
    return null;
}

/** The file's own indentation, so a two-space file is not rewritten as four. */
function indentOf(text) {
    const m = /\n([ \t]+)"/.exec(text);
    return m ? m[1] : 2;
}

function readPrd(prdPath) {
    const text = fs.readFileSync(prdPath, 'utf8');
    return { text, prd: JSON.parse(text) };
}

function writePrd(prdPath, prd, originalText) {
    const out = JSON.stringify(prd, null, indentOf(originalText)) + (originalText.endsWith('\n') ? '\n' : '');
    fs.writeFileSync(prdPath, out);
}

function line(stories) {
    const c = S.summarise(stories);
    const ids = Object.entries(stories).filter(([, s]) => S.needsSetup(s)).map(([id]) => id);
    return `remaining ${c.outstanding} (${c.actionable} actionable, ${c.needsSetup} blocked on you`
        + (ids.length ? `: ${ids.join(', ')}` : '') + ')';
}

/** Returns { code, message, changed }. Pure over the parsed file; the CLI does I/O. */
function mark(prd, id, reason) {
    const stories = S.storiesOf(prd);
    const container = locate(prd, id);
    if (!container) {
        const n = Object.keys(stories).length;
        return { code: 2, changed: false, message: `${id}: no such story (${n} read from the file)` };
    }
    const story = container[id];
    if (S.isDone(story)) {
        return { code: 2, changed: false, message: `${id}: passes is true — done work is not blocked on anyone` };
    }
    if (S.isDeferred(story)) {
        return { code: 2, changed: false, message: `${id}: passes is "deferred" — a decision not to do it is not a block on a person. Set it to null first if that decision is being reversed.` };
    }
    const text = String(reason == null ? '' : reason).trim();
    if (!text) {
        return { code: 2, changed: false, message: `${id}: a reason is required — what is needed, where (the console URL or path), and what done looks like` };
    }
    if (S.needsSetup(story) && story.blockedReason === text) {
        return { code: 0, changed: false, message: `${id}: already needs-setup with this reason (no change). ${line(stories)}` };
    }
    const was = S.needsSetup(story) ? 'needs-setup, reason updated' : JSON.stringify(story.passes === undefined ? null : story.passes);
    story.passes = S.NEEDS_SETUP;
    story.blockedReason = text;
    story.blockedAt = new Date().toISOString().slice(0, 10);
    return { code: 0, changed: true, message: `${id} -> needs-setup (was ${was}): ${text}\n${line(S.storiesOf(prd))}` };
}

function clear(prd, id) {
    const stories = S.storiesOf(prd);
    const container = locate(prd, id);
    if (!container) {
        return { code: 2, changed: false, message: `${id}: no such story (${Object.keys(stories).length} read from the file)` };
    }
    const story = container[id];
    if (!S.needsSetup(story)) {
        return { code: 2, changed: false, message: `${id}: passes is ${JSON.stringify(story.passes === undefined ? null : story.passes)}, not "needs-setup" — nothing to clear` };
    }
    story.passes = S.PENDING;
    delete story.blockedReason;
    delete story.blockedAt;
    return { code: 0, changed: true, message: `${id} -> pending (setup done; an agent can pick it up)\n${line(S.storiesOf(prd))}` };
}

function list(prd) {
    const stories = S.storiesOf(prd);
    const blocked = Object.entries(stories).filter(([, s]) => S.needsSetup(s));
    const lines = [line(stories)];
    for (const [id, s] of blocked) {
        const since = s.blockedAt ? ` (since ${s.blockedAt})` : '';
        lines.push(`  ${id}${since}: ${String(s.title || '').slice(0, 80)}`);
        lines.push(`      ${s.blockedReason || '(no reason recorded — mark it again with one)'}`);
    }
    return { code: 0, changed: false, message: lines.join('\n') };
}

function main(argv) {
    if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
        process.stdout.write(HELP);
        return argv.length === 0 ? 2 : 0;
    }
    const prdPath = (() => {
        const i = argv.indexOf('--prd');
        return path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : 'prd.json');
    })();
    const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--prd');

    let file;
    try { file = readPrd(prdPath); } catch (e) {
        process.stderr.write(`prd-mark-needs-setup: cannot read ${prdPath}: ${e.message}\n`);
        return 2;
    }

    let r;
    if (argv.includes('--list')) r = list(file.prd);
    else if (argv.includes('--clear')) r = clear(file.prd, positional[0]);
    else r = mark(file.prd, positional[0], positional.slice(1).join(' '));

    if (r.changed) writePrd(prdPath, file.prd, file.text);
    (r.code === 0 ? process.stdout : process.stderr).write(r.message + '\n');
    return r.code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { mark, clear, list, locate, indentOf };
