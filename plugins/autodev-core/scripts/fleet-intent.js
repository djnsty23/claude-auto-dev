#!/usr/bin/env node
'use strict';
/**
 * fleet-intent.js — the record that survives a session.
 *
 * WHY THIS EXISTS, `[measured 2026-09-08]`. A usage limit killed part of a
 * 39-session fleet overnight. Every COMMIT was recoverable — 25 bundles, and
 * PR #178 classified all 39 heads afterwards. The INTENT was not. Reconstructing
 * "what was this session doing, and what does the next one do first" took a
 * coordinator a night of reading transcripts and guessing from PR titles.
 * Several sessions woke after nine hours and had to be told the tree had moved,
 * that their PR had merged, or that their premise was dead.
 *
 * A commit is recoverable. An intention is not, unless it was written down.
 *
 * ── WHO CAN WRITE WHICH FIELD. This is the whole design, and it was measured
 * rather than assumed. Three writers were considered:
 *
 *   (a) a hook deriving the record from the tree and the forge
 *   (b) the session writing it at natural boundaries
 *   (c) a periodic sweep reconstructing it from outside
 *
 * (a) and (c) can only ever produce the same four things, because they read the
 * same two sources. A Stop payload carries `session_id` and `cwd`; a tree
 * carries a head, a branch, a dirty bit and a distance from the trunk. Neither
 * names an INTENTION.
 *
 * The forge was the last hope for (c), and it was measured: across all 202 pull
 * requests in this repo — every one with a non-empty body, the longest 10,625
 * characters — **0 carry a next-step heading, 8 mention a next step anywhere,
 * and 8 carry a runnable command at the start of a line.** (Each pattern was run
 * against a known-positive control first, so a zero is a finding about the
 * corpus and not about the regex.) A PR body is written about what LANDED. It
 * is not a record of what comes next, and a sweep built on it would hand the
 * re-dispatcher a `next_step` about four times in a hundred.
 *
 * So the fields split by who can possibly know them:
 *
 *   CLAIMED   brief, current_step, next_step, verify, state — only the session.
 *   OBSERVED  head, dirty, ahead, on_trunk — anyone, any time, for free.
 *
 * and the split is load-bearing rather than cosmetic, because of the next rule.
 *
 * ── AN OBSERVER MUST NEVER TOUCH `updated_at`. It is tempting to have the hook
 * bump the timestamp every turn so the record "looks maintained". That converts
 * this file into the exact failure it was built against: a stale claim wearing a
 * fresh date. The fleet spent a whole night on that class, and its sharpest
 * form is that a stale OPEN claim makes the next reader SKIP work already done —
 * and skipping emits no output, no failure and no diff.
 *
 * `updated_at` therefore dates the CLAIM and moves only when a claim changes.
 * `observed.at` dates the FACTS and moves whenever anyone looks. A reader can
 * always say "the session claimed this 9 hours ago; the tree has moved 3 commits
 * since", which is the sentence the coordinator spent the night assembling by
 * hand.
 *
 * ── PREFER "I CANNOT TELL". Every derived verdict here has an UNKNOWN value and
 * every one of them is reachable: no git, no upstream, a record written before
 * `claim_head` existed. None of them degrades to a guess, because a wrong
 * confident answer is what sends the next session to the wrong place.
 *
 * ── KEYED BY repo+branch, NEVER BY cwd. A worktree outlives the session in it,
 * so a directory names a PLACE, not a correspondent. `[measured 2026-09-04]` a
 * cwd fallback in another script delivered three sessions' idle reports to
 * whoever next occupied the worktree, two of them client sessions. `session_id`
 * is stored as PROVENANCE — it says who made the claim — and is never the key.
 *
 * ── WHERE. ~/claude-memory/fleet-intent/<repo>--<branch>.json, one file per
 * record so two sessions writing at once cannot lose each other's work. On this
 * machine that directory is not a git repo, so nothing here publishes anywhere;
 * a caller that syncs it must decide for itself whether a `brief` naming client
 * work may leave the disk. This file writes locally and pushes nothing.
 *
 * Usage:
 *   node fleet-intent.js                       # read the record for cwd's repo+branch
 *   node fleet-intent.js --set --brief "..." --next "..." --verify "npm run gate"
 *   node fleet-intent.js --set --state checkpointed
 *   node fleet-intent.js --read --repo autodev --branch claude/foo
 *   node fleet-intent.js --list [--json]       # every record, most doubtful first
 *   node fleet-intent.js --observe             # refresh only the facts, no claim
 *   node fleet-intent.js --selftest
 *
 * Exit: 0 read or wrote something, 1 nothing to report, 2 could not run.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

/** Where records live. Overridable so a suite never touches the real fleet. */
function recordDir() {
    return process.env.AUTODEV_FLEET_INTENT_DIR
        || path.join(HOME, 'claude-memory', 'fleet-intent');
}

/**
 * The five values `state` may hold, and the sixth thing that can happen.
 *
 * `unrecognised` is not decoration. This repo's `passes` field has five states
 * and every hand-rolled reader of it has been wrong by folding one into its
 * neighbour; `prd-states.js` carries an `unrecognised` bucket for exactly that
 * reason. A `state` this file has never heard of must surface as itself, not be
 * rounded to `working` (which would say an abandoned session is running) nor to
 * `blocked` (which would summon a human who is not needed).
 */
const STATES = ['working', 'checkpointed', 'complete', 'blocked'];

/** Do the claim fields say there is remaining work? null when it cannot be told. */
function hasRemainingWork(state) {
    if (state === 'working' || state === 'checkpointed' || state === 'blocked') return true;
    if (state === 'complete') return false;
    return null;                                   // unrecognised: say so, do not guess
}

/** Can an agent act on it, or does it wait on a person? null when unknown. */
function agentCanAct(state) {
    if (state === 'working' || state === 'checkpointed') return true;
    if (state === 'blocked') return false;         // waits on a human, like needs-setup
    if (state === 'complete') return false;
    return null;
}

/**
 * The filename for a repo+branch.
 *
 * The contract is `<repo>--<branch>.json` with `/` in the branch becoming `-`.
 * That alone is not safe to hand to `path.join`: a branch may legally contain
 * characters that are path separators on Windows, and a name like `..` would
 * escape the directory. So every character outside `[A-Za-z0-9._-]` becomes `-`
 * as well, and a leading dot is neutralised.
 *
 * ⚠️ THE MAPPING IS NOT INJECTIVE, AND THE READER COMPENSATES. `claude/foo` and
 * a literal branch `claude-foo` both slug to `claude-foo`. Rather than pretend
 * that cannot happen, every record stores its `branch` verbatim and `readRecord`
 * refuses to serve a record whose stored branch is not the one asked for. A
 * collision reads as "I cannot tell", never as someone else's plan.
 */
function slug(s) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/\//g, '-')
        .replace(/[^A-Za-z0-9._-]/g, '-')
        .replace(/^\.+/, '_');
}

function keyFor(repo, branch) {
    return slug(repo) + '--' + slug(branch);
}

function recordPath(repo, branch, dir) {
    return path.join(dir || recordDir(), keyFor(repo, branch) + '.json');
}

// ── reading the world ────────────────────────────────────────────────────────

function git(cwd, args) {
    try {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
        if (r.status !== 0) return null;
        return (r.stdout || '').trim();
    } catch {
        return null;
    }
}

/**
 * The repo NAME for a working directory, which is not its top-level directory.
 *
 * In a worktree `--show-toplevel` is the worktree path — for this fleet that is
 * `.../autodev/.claude/worktrees/nostalgic-bun-ee5c21`, so keying on it would
 * give every worktree of one repo a different repo name and scatter one repo's
 * records across forty files. `--git-common-dir` points at the shared `.git` of
 * the main checkout in a worktree and at the ordinary `.git` otherwise, so its
 * parent is the repo in both shapes.
 */
function repoName(cwd) {
    let common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!common) {
        // git < 2.31 has no --path-format; the answer may then be relative to cwd.
        const rel = git(cwd, ['rev-parse', '--git-common-dir']);
        if (!rel) return null;
        common = path.resolve(cwd, rel);
    }
    const base = path.basename(common);
    const dir = base === '.git' ? path.dirname(common) : common.replace(/\.git$/, '');
    const name = path.basename(dir);
    return name && name !== '.' && name !== path.sep ? name : null;
}

function branchOf(cwd) {
    const b = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return b && b !== 'HEAD' ? b : null;           // detached HEAD has no branch to key on
}

/**
 * The facts, all of them cheap and local. Every field is null when unknowable;
 * none of them is inferred from another.
 *
 * `on_trunk` resolves `origin/HEAD` rather than assuming `origin/main`, because
 * one repo in this fleet has a `main` two months behind its real trunk.
 */
function observe(cwd) {
    const at = new Date().toISOString();
    const head = git(cwd, ['rev-parse', 'HEAD']);
    if (!head) return { at, head: null, dirty: null, ahead: null, on_trunk: null };

    const status = git(cwd, ['status', '--porcelain']);
    const dirty = status === null ? null : status.length > 0;

    const aheadRaw = git(cwd, ['rev-list', '--count', '@{upstream}..HEAD']);
    const ahead = aheadRaw === null ? null : (Number.isFinite(Number(aheadRaw)) ? Number(aheadRaw) : null);

    let trunk = git(cwd, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
    trunk = trunk ? trunk.replace(/^refs\/remotes\//, '') : null;
    if (!trunk && git(cwd, ['rev-parse', '--verify', '--quiet', 'origin/main']) !== null) trunk = 'origin/main';

    let on_trunk = null;
    if (trunk) {
        try {
            const r = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', trunk],
                { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
            if (r.status === 0) on_trunk = true;
            else if (r.status === 1) on_trunk = false;
        } catch { /* stays null */ }
    }
    return { at, head, dirty, ahead, on_trunk };
}

// ── the record ───────────────────────────────────────────────────────────────

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Read one record.
 *
 * Returns `{ record, collision }`. `collision` is true when a record exists at
 * this key but names a different branch — see the note on `slug`. A collision
 * yields `record: null`, because half a plan belonging to someone else is worse
 * than no plan.
 */
function readRecord(repo, branch, dir) {
    const p = recordPath(repo, branch, dir);
    const rec = readJson(p);
    if (!rec || typeof rec !== 'object') return { record: null, collision: false, path: p };
    if (typeof rec.branch === 'string' && rec.branch !== branch) {
        return { record: null, collision: true, path: p };
    }
    return { record: rec, collision: false, path: p };
}

const CLAIM_FIELDS = ['brief', 'current_step', 'next_step', 'verify', 'state'];

/**
 * Write or update a record, merging into whatever is already there.
 *
 * MERGE, NOT REPLACE, and that is deliberate. The commonest write is a single
 * field — `--state checkpointed` as the limit lands. If that replaced the file,
 * the one write most likely to happen under pressure would destroy the brief it
 * exists to preserve.
 *
 * `updated_at` moves ONLY when a claim field actually changes value. Re-asserting
 * the same brief does not refresh the date: it is the same claim, and dating it
 * "now" is how a nine-hour-old plan comes to look current.
 */
function writeRecord({ repo, branch, session_id, claim, observed, dir }) {
    if (!repo || !branch) throw new Error('a record needs both a repo and a branch');
    const d = dir || recordDir();
    const p = recordPath(repo, branch, d);
    const prior = readRecord(repo, branch, d).record || {};

    const next = Object.assign({}, prior, {
        schema: 1,
        repo,
        branch,
    });
    if (session_id) next.session_id = session_id;
    for (const f of CLAIM_FIELDS) if (!(f in next)) next[f] = null;

    let changed = false;
    for (const f of CLAIM_FIELDS) {
        if (!claim || !(f in claim) || claim[f] === undefined) continue;
        const v = claim[f] === null ? null : String(claim[f]);
        if (next[f] !== v) { next[f] = v; changed = true; }
    }

    if (changed || !prior.updated_at) {
        next.updated_at = new Date().toISOString();
        // The claim is pinned to the tree it was made about, so a later reader
        // can tell a fresh plan from one the tree has walked away from.
        next.claim_head = observed && observed.head ? observed.head : null;
    }
    if (observed) next.observed = observed;

    fs.mkdirSync(d, { recursive: true });
    const tmp = p + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 1) + '\n');
    fs.renameSync(tmp, p);                          // atomic: a reader sees old or new, never half
    return { record: next, path: p, changed };
}

/**
 * What a reader may conclude, given a record and a fresh look at the tree.
 *
 * Nothing here is a recommendation. It answers three questions and admits when
 * it cannot: how old is the claim, has the tree moved under it, and is the
 * record complete enough to act on.
 */
function assess(record, observed, now) {
    const t = now === undefined ? Date.now() : now;
    const out = {
        age_min: null,
        moved: null,
        missing: [],
        remaining_work: null,
        agent_can_act: null,
        state_recognised: null,
        confidence: 'unknown',
    };
    if (!record) return out;

    const ts = Date.parse(record.updated_at);
    if (Number.isFinite(ts)) out.age_min = Math.round((t - ts) / 60000);

    // "Has the tree moved since the claim was made" needs BOTH shas. Missing
    // either one is an unknown, never a "no".
    if (record.claim_head && observed && observed.head) {
        out.moved = record.claim_head !== observed.head;
    }

    for (const f of CLAIM_FIELDS) {
        const v = record[f];
        if (v === null || v === undefined || String(v).trim() === '') out.missing.push(f);
    }

    out.state_recognised = STATES.includes(record.state);
    out.remaining_work = hasRemainingWork(record.state);
    out.agent_can_act = agentCanAct(record.state);

    // `verify` is the field that stops the record rotting: a claim carrying a
    // re-check command can be tested by the reader, however old it is. A record
    // without one is a memory, and it rots.
    const hasVerify = !out.missing.includes('verify');
    if (out.moved === true) out.confidence = 'tree-moved';
    else if (out.moved === false && hasVerify) out.confidence = 'checkable';
    else if (out.moved === false) out.confidence = 'unverifiable';
    else out.confidence = 'unknown';
    return out;
}

/** Every record on disk. Always reports what it scanned. */
function readAll(dir) {
    const d = dir || recordDir();
    let names;
    try { names = fs.readdirSync(d); } catch { return { dir: d, scanned: 0, records: [] }; }
    const files = names.filter((n) => n.endsWith('.json'));
    const records = [];
    for (const n of files) {
        const rec = readJson(path.join(d, n));
        if (rec && typeof rec === 'object') records.push(rec);
    }
    return { dir: d, scanned: files.length, records };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, dflt) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : dflt; };

function help() {
    console.log('fleet-intent.js — the record that survives a session.');
    console.log('Keyed by repo+branch, never by cwd. Claims are written by the session;');
    console.log('facts are observed by anyone. An observer never touches updated_at.\n');
    console.log('node fleet-intent.js [--read] [--repo R --branch B]');
    console.log('node fleet-intent.js --set [--brief T] [--current T] [--next T] [--verify CMD] [--state S]');
    console.log('node fleet-intent.js --observe          refresh the facts only; touches no claim');
    console.log('node fleet-intent.js --list [--json]    every record, most doubtful first');
    console.log('node fleet-intent.js --selftest');
    console.log('\nstates: ' + STATES.join(' | ') + '  (anything else is reported as unrecognised)');
    console.log('dir:    $AUTODEV_FLEET_INTENT_DIR, else ~/claude-memory/fleet-intent');
}

function describe(record, ass, collision) {
    if (collision) {
        return 'COLLISION: a record exists at this key for a different branch. '
            + 'Two branch names slug to one filename. Nothing is served; treat it as no record.';
    }
    if (!record) return 'no intent record for this repo+branch.';
    const age = ass.age_min === null ? 'age unknown'
        : ass.age_min < 90 ? ass.age_min + 'm old'
            : Math.round(ass.age_min / 60) + 'h old';
    const moved = ass.moved === null ? 'cannot tell whether the tree moved'
        : ass.moved ? 'THE TREE HAS MOVED since this was claimed'
            : 'tree unchanged since this was claimed';
    const lines = [
        record.repo + ' ' + record.branch + '  [' + record.state + ']  ' + age + ', ' + moved,
        record.brief ? '  brief   ' + record.brief : '  brief   (not stated)',
        record.current_step ? '  now     ' + record.current_step : '  now     (not stated)',
        record.next_step ? '  next    ' + record.next_step : '  next    (not stated)',
        record.verify ? '  verify  ' + record.verify : '  verify  (NONE — this record cannot be re-checked, so it rots)',
    ];
    if (!ass.state_recognised) {
        lines.push('  ⚠ state "' + record.state + '" is not one of: ' + STATES.join(', ')
            + ' — reported as-is rather than folded into a neighbour.');
    }
    if (record.session_id) lines.push('  claimed by session ' + record.session_id + ' (provenance, not an address)');
    return lines.join('\n');
}

function main() {
    if (has('--help') || has('-h')) { help(); return 0; }

    if (has('--selftest')) return selftest();

    const cwd = process.cwd();
    const repo = val('--repo', null) || repoName(cwd);
    const branch = val('--branch', null) || branchOf(cwd);

    if (has('--list')) {
        const all = readAll();
        const rows = all.records.map((r) => ({ r, a: assess(r, null) }));
        rows.sort((x, y) => (y.a.age_min || 0) - (x.a.age_min || 0));
        if (has('--json')) { console.log(JSON.stringify({ dir: all.dir, scanned: all.scanned, records: all.records }, null, 1)); return all.scanned ? 0 : 1; }
        console.log(all.scanned + ' record file(s) in ' + all.dir + (all.scanned ? '' : ' — nothing scanned, so this is a statement about the directory, not the fleet'));
        for (const { r, a } of rows) console.log('\n' + describe(r, a, false));
        return all.scanned ? 0 : 1;
    }

    if (!repo || !branch) {
        console.error('COULD NOT RUN: no repo+branch. cwd is not a git repo with a named branch'
            + (branchOf(cwd) === null ? ' (detached HEAD has no branch to key on)' : '')
            + '. Pass --repo and --branch explicitly.');
        return 2;
    }

    if (has('--set') || has('--observe')) {
        const observed = observe(cwd);
        const claim = {};
        if (!has('--observe')) {
            if (has('--brief')) claim.brief = val('--brief', '');
            if (has('--current')) claim.current_step = val('--current', '');
            if (has('--next')) claim.next_step = val('--next', '');
            if (has('--verify')) claim.verify = val('--verify', '');
            if (has('--state')) claim.state = val('--state', '');
        }
        const session_id = val('--session', null) || process.env.CLAUDE_SESSION_ID || null;
        const w = writeRecord({ repo, branch, session_id, claim, observed });
        const a = assess(w.record, observed);
        console.log((w.changed ? 'claim updated' : 'facts refreshed, claim unchanged') + ' -> ' + w.path);
        if (a.missing.length) {
            console.log('  still unstated: ' + a.missing.join(', ')
                + (a.missing.includes('verify') ? '\n  ⚠ without `verify` the next reader cannot re-check this claim, only believe it.' : ''));
        }
        return 0;
    }

    /* ⚠️ ONLY OBSERVE THE TREE THE RECORD IS ABOUT.
       `--read --repo X --branch Y` asks about somewhere else. Observing `cwd`
       and comparing ITS head against that record's `claim_head` compares two
       unrelated trees, and they will differ, so the reader is told "THE TREE HAS
       MOVED" about a record that is perfectly fresh. That is the precise failure
       this file exists to prevent, arriving from the other direction: a false
       ALARM sends a session to redo finished work, where a false all-clear makes
       it skip work. Caught by the suite, which read a record for another branch
       from this repo's own directory.
       A caller who wants the facts for another checkout runs this in it. From
       here the honest answer is that the tree cannot be seen. */
    const { record, collision, path: p } = readRecord(repo, branch);
    const aboutHere = repo === repoName(cwd) && branch === branchOf(cwd);
    const observed = aboutHere ? observe(cwd) : null;
    const a = assess(record, observed);
    if (has('--json')) { console.log(JSON.stringify({ path: p, collision, record, observed, observed_here: aboutHere, assessment: a }, null, 1)); return record ? 0 : 1; }
    console.log(describe(record, a, collision));
    if (record && !aboutHere) console.log('  (this record is about another checkout; its tree was not read from here)');
    if (!record && !collision) console.log('  (looked at ' + p + ')');
    return record ? 0 : 1;
}

/**
 * Controls. Every verdict this file can print must be shown to be REACHABLE,
 * because a checker that cannot fire reads exactly like a clean tree.
 */
function selftest() {
    const fails = [];
    let ran = 0;
    const t = (name, cond) => { ran++; if (!cond) fails.push(name); };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-intent-selftest-'));

    t('slug maps / to -', slug('claude/foo') === 'claude-foo');
    t('slug neutralises ..', slug('..') === '_.' || !slug('..').startsWith('.'));
    t('slug drops separators', !slug('a\\b/c').includes(path.sep) || process.platform !== 'win32');

    const w = writeRecord({ repo: 'r', branch: 'claude/x', claim: { brief: 'b', verify: 'npm run gate', state: 'working' }, observed: { at: 'now', head: 'aaa' }, dir: tmp });
    t('write then read round-trips', readRecord('r', 'claude/x', tmp).record.brief === 'b');

    const w2 = writeRecord({ repo: 'r', branch: 'claude/x', claim: { brief: 'b' }, observed: { at: 'now', head: 'aaa' }, dir: tmp });
    t('re-asserting the same claim does not refresh updated_at', w2.record.updated_at === w.record.updated_at);
    t('merge keeps the brief when only state is written',
        writeRecord({ repo: 'r', branch: 'claude/x', claim: { state: 'checkpointed' }, observed: { at: 'now', head: 'aaa' }, dir: tmp }).record.brief === 'b');

    // A collision must read as nothing, not as someone else's plan.
    fs.writeFileSync(path.join(tmp, keyFor('r', 'claude-y') + '.json'), JSON.stringify({ repo: 'r', branch: 'claude-y', brief: 'other' }));
    t('collision serves no record', readRecord('r', 'claude/y', tmp).collision === true);

    const rec = readRecord('r', 'claude/x', tmp).record;
    t('moved is true when head differs', assess(rec, { head: 'bbb' }).moved === true);
    t('moved is false when head matches', assess(rec, { head: 'aaa' }).moved === false);
    t('moved is UNKNOWN with no observation', assess(rec, null).moved === null);
    t('confidence unknown is reachable', assess(rec, null).confidence === 'unknown');
    t('confidence tree-moved is reachable', assess(rec, { head: 'bbb' }).confidence === 'tree-moved');
    t('confidence checkable is reachable', assess(rec, { head: 'aaa' }).confidence === 'checkable');
    t('confidence unverifiable is reachable',
        assess({ updated_at: new Date().toISOString(), claim_head: 'aaa', state: 'working' }, { head: 'aaa' }).confidence === 'unverifiable');
    t('missing verify is named', assess({ claim_head: 'a', state: 'working' }, { head: 'a' }).missing.includes('verify'));

    t('unrecognised state is not folded into working', hasRemainingWork('sleeping') === null);
    t('unrecognised state is not folded into blocked', agentCanAct('sleeping') === null);
    t('blocked means an agent cannot act', agentCanAct('blocked') === false);
    t('blocked still counts as remaining work', hasRemainingWork('blocked') === true);
    t('complete is not remaining work', hasRemainingWork('complete') === false);
    t('state_recognised is false for a sixth value', assess({ state: 'sleeping' }, null).state_recognised === false);

    const all = readAll(tmp);
    t('readAll reports what it scanned', all.scanned >= 2);
    t('readAll of a missing dir reports zero scanned', readAll(path.join(tmp, 'nope')).scanned === 0);

    fs.rmSync(tmp, { recursive: true, force: true });
    if (fails.length) {
        console.error('SELFTEST FAILED (' + fails.length + ' of ' + ran + '):');
        for (const f of fails) console.error('  - ' + f);
        return 1;
    }
    console.log('selftest OK — ' + ran + ' controls, every verdict shown reachable');
    return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
    STATES, slug, keyFor, recordPath, repoName, branchOf, observe,
    readRecord, writeRecord, readAll, assess, hasRemainingWork, agentCanAct,
    recordDir, CLAIM_FIELDS,
};
