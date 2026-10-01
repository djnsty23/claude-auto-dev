#!/usr/bin/env node
// Tests for autodev-core's SessionStart hook.
//
// The hook previously emitted plain stdout and did two things that could not
// work: it parsed .env.local into process.env (a hook cannot set environment
// variables for the session — the values died with the hook process, while it
// still printed "[Env] .env.local loaded"), and it rewrote the version number
// inside the user's own MEMORY.md. Both are asserted gone here.
//
// A HOOK CHILD THAT DIED OF THE MACHINE SAID NOTHING ABOUT THE HOOK. Every
// spawn of the hook goes through spawn-budget.js runVerdict, which re-runs a
// child that died (nativeDeath) and, when one never answers, stops grading:
// the cases after it print SKIP and the suite exits 2. An ABSENCE check reads
// the parsed output first (`out !== null &&`), so a hook that exits 0 and
// prints nothing fails it instead of passing it.
//
// Run: node tooling/test-session-start-hook.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sb = require('./spawn-budget.js');

const PLUGIN_ROOT = path.resolve(__dirname, '..', 'plugins', 'autodev-core');
const HOOK = path.join(PLUGIN_ROOT, 'hooks', 'session-start.js');
// Comments are stripped before the "no longer present" source assertions below:
// the hook deliberately documents what was removed and why, and a naive
// substring search would match that prose forever.
const HOOK_CODE = fs.readFileSync(HOOK, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstart-test-')));
const PROJ = path.join(TMP, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

const cases = [];
const check = (label, ok) => cases.push([label, ok, sb.lostVerdict()]);
// Checks that await, run in order before the results print.
const later = [];

// Every variable a session-store reader resolves its path from points at one
// empty dir, so no run reads the machine's real Desktop store. Without this the
// pile count, its timing, and whether a "Session pile" line prints all depended
// on who ran the suite: [measured 2026-09-24] 1,229 records, 412 ms, per run.
const EMPTY_STORE = path.join(TMP, 'empty-store');
fs.mkdirSync(EMPTY_STORE, { recursive: true });
const STORE_VARS = ['SESSION_SWEEP_STORE', 'CLAUDE_SESSION_STORE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'];

function hookEnv(extraEnv = {}) {
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HOME: TMP, USERPROFILE: TMP, CLAUDE_CONFIG_DIR: path.join(TMP, '.claude') };
    for (const v of STORE_VARS) env[v] = EMPTY_STORE;
    // An undefined value removes the variable: spawn skips it.
    return { ...env, ...extraEnv };
}

// The hook only ever exits 0, so no exit code is expected of it.
function spawnHook(input, opts) {
    return sb.runVerdict(process.execPath, [HOOK], Object.assign({ input, encoding: 'utf8' }, opts));
}

function run(payload, cwd = PROJ, extraEnv = {}) {
    return spawnHook(JSON.stringify(payload), { cwd, env: hookEnv(extraEnv) });
}

function parse(r) {
    try { return JSON.parse(r.stdout); } catch { return null; }
}

// The hook's additionalContext, or null when it printed no JSON at all. An
// absence check reads null as "no answer", never as "absent".
function contextOf(r) {
    const out = parse(r);
    return out === null ? null : (out.hookSpecificOutput?.additionalContext || '');
}

// 1. No prd.json — banner only, still valid JSON.
let r = run({ cwd: PROJ, session_id: 's1', hook_event_name: 'SessionStart' });
let out = parse(r);
check('exits 0 with no prd.json', r.status === 0);
check('emits valid JSON', out !== null);
check('emits a version banner as systemMessage', /^\[Auto-Dev v/.test(out?.systemMessage || ''));
check('reports the real version, not a hardcoded fallback', out !== null && !/v\?\]/.test(out.systemMessage || ''));

// 2. With prd.json — sprint state goes to additionalContext, where Claude reads it.
fs.writeFileSync(path.join(PROJ, 'prd.json'), JSON.stringify({
    sprint: 'S3',
    stories: {
        'S3-001': { title: 'ship the thing', passes: true },
        'S3-002': { title: 'fix the bug', passes: null },
        'S3-003': { title: 'later', passes: 'deferred' },
    },
}));
r = run({ cwd: PROJ, session_id: 's2', hook_event_name: 'SessionStart' });
out = parse(r);
const ctx = out?.hookSpecificOutput?.additionalContext || '';
check('exits 0 with prd.json', r.status === 0);
check('additionalContext is used for sprint state', ctx.includes('Sprint S3'));
check('counts done correctly', ctx.includes('1 done'));
check('counts pending correctly', ctx.includes('1 pending'));
check('counts deferred separately from pending', ctx.includes('1 deferred'));
check('names the next pending story', ctx.includes('S3-002'));
check('banner still summarises for the user', (out?.systemMessage || '').includes('Sprint S3'));

// 2b. FAILED is its own bucket, never folded into pending.
//
// `[measured 2026-08-28]` a live session opened with "0 done, 8 pending" against
// a file holding 5 null and 3 false. The hook called `isActionable` "pending",
// and isActionable is deliberately true for FAILED too — so every failed story
// was reported as one more waiting to be started. The operator would have read a
// clean backlog where three things had actually broken.
fs.writeFileSync(path.join(PROJ, 'prd.json'), JSON.stringify({
    sprint: 'S4',
    stories: {
        'S4-P1': { title: 'pending one', passes: null },
        'S4-P2': { title: 'pending two', passes: null },
        'S4-F1': { title: 'failed one', passes: false },
        'S4-F2': { title: 'failed two', passes: false },
        'S4-F3': { title: 'failed three', passes: false },
    },
}));
r = run({ cwd: PROJ, session_id: 's2b', hook_event_name: 'SessionStart' });
const cF = parse(r)?.hookSpecificOutput?.additionalContext || '';
check('FAILED stories are not counted as pending', /\b2 pending\b/.test(cF));
check('FAILED gets its own named bucket', /\b3 FAILED\b/.test(cF));
check('does not report the old folded count', parse(r) !== null && !/\b5 pending\b/.test(cF));

// 2c. Archived work is counted, because completed stories LEAVE this file.
// Counting `stories` alone is a count over the file, not over the project: a
// project that had shipped and archived 159 stories opened every session with
// "0 done" — true of the file, and the opposite of true about the work.
fs.writeFileSync(path.join(PROJ, 'prd.json'), JSON.stringify({
    sprint: 'S4',
    // Shape as `archive-prd` writes it, not invented here.
    archived: {
        totalCompleted: 159,
        lastArchived: '2026-08-28',
        files: ['.claude/archives/prd-archive-2026-08.json'],
    },
    stories: {
        'S4-P1': { title: 'pending one', passes: null },
        'S4-F1': { title: 'failed one', passes: false },
    },
}));
r = run({ cwd: PROJ, session_id: 's2c', hook_event_name: 'SessionStart' });
const cA = parse(r)?.hookSpecificOutput?.additionalContext || '';
check('surfaces the archived completion count', cA.includes('+159 archived'));
check('separates active total from all-time', cA.includes('2 active, 161 all-time'));
check('still reports 0 done for the active file', /\b0 done\b/.test(cA));

// 2d. An archive section whose count will not parse is NOT zero.
// "none" and "I could not read it" are opposite facts and must not flatten.
fs.writeFileSync(path.join(PROJ, 'prd.json'), JSON.stringify({
    sprint: 'S4',
    archived: { files: ['.claude/archives/prd-archive-2026-08.json'] },
    stories: { 'S4-P1': { title: 'pending one', passes: null } },
}));
r = run({ cwd: PROJ, session_id: 's2d', hook_event_name: 'SessionStart' });
const cU = parse(r)?.hookSpecificOutput?.additionalContext || '';
check('unreadable archive count is named, not rendered as zero', cU.includes('count unreadable'));
check('does not fabricate a +0 archived', parse(r) !== null && !cU.includes('+0 archived'));

// 2e. No archive section at all is a real zero and says nothing extra.
fs.writeFileSync(path.join(PROJ, 'prd.json'), JSON.stringify({
    sprint: 'S4',
    stories: { 'S4-P1': { title: 'pending one', passes: null } },
}));
r = run({ cwd: PROJ, session_id: 's2e', hook_event_name: 'SessionStart' });
const cN = parse(r)?.hookSpecificOutput?.additionalContext || '';
check('no archive section adds no archive note', parse(r) !== null && !/archived|unreadable/.test(cN));
check('reports a plain total when nothing is archived', cN.includes('1 total'));

// 2f. A SIXTH state must be visible, not folded into a neighbour.
// This is exactly how `needs-setup` stayed invisible across five readers.
fs.writeFileSync(path.join(PROJ, 'prd.json'), JSON.stringify({
    sprint: 'S4',
    stories: {
        'S4-P1': { title: 'pending one', passes: null },
        'S4-S1': { title: 'waiting on a key', passes: 'needs-setup' },
        'S4-X1': { title: 'from a future schema', passes: 'quarantined' },
    },
}));
r = run({ cwd: PROJ, session_id: 's2f', hook_event_name: 'SessionStart' });
const cS = parse(r)?.hookSpecificOutput?.additionalContext || '';
check('needs-setup is reported separately', cS.includes('1 blocked on setup'));
check('an unrecognised passes value is counted, not silently dropped', cS.includes('1 unrecognised'));
check('an unrecognised value is not folded into pending', /\b1 pending\b/.test(cS));

// 3. Malformed prd.json is surfaced, not swallowed.
fs.writeFileSync(path.join(PROJ, 'prd.json'), '{ not valid json');
r = run({ cwd: PROJ, session_id: 's3', hook_event_name: 'SessionStart' });
out = parse(r);
check('exits 0 on malformed prd.json', r.status === 0);
check('reports the parse failure in context',
    (out?.hookSpecificOutput?.additionalContext || '').includes('failed to parse'));
fs.rmSync(path.join(PROJ, 'prd.json'));

// 4. The hook honours payload cwd over its own process cwd.
const OTHER = path.join(TMP, 'other');
fs.mkdirSync(OTHER, { recursive: true });
fs.writeFileSync(path.join(OTHER, 'prd.json'), JSON.stringify({ sprint: 'S9', stories: {} }));
r = run({ cwd: OTHER, session_id: 's4', hook_event_name: 'SessionStart' }, PROJ);
check('uses payload cwd, not process cwd', (parse(r)?.systemMessage || '').includes('Sprint S9'));

// 5. Regression: .env.local must not be read at all.
fs.writeFileSync(path.join(PROJ, '.env.local'), 'SECRET_TOKEN=sk_live_should_never_be_touched\n');
r = run({ cwd: PROJ, session_id: 's5', hook_event_name: 'SessionStart' });
const whole = (r.stdout || '') + (r.stderr || '');
const heard = parse(r) !== null;
check('does not claim to have loaded .env.local', heard && !whole.includes('.env.local loaded'));
check('does not echo secrets from .env.local', heard && !whole.includes('sk_live_should_never_be_touched'));
check('no .env.local parsing remains in the source', !HOOK_CODE.includes('.env.local'));

// 6. Regression: the user's MEMORY.md must not be rewritten.
const memDir = path.join(TMP, '.claude', 'projects', 'encoded-proj', 'memory');
fs.mkdirSync(memDir, { recursive: true });
const memFile = path.join(memDir, 'MEMORY.md');
const memBefore = '## Project: demo (v1.0)\n\nnotes\n';
fs.writeFileSync(memFile, memBefore);
r = run({ cwd: PROJ, session_id: 's6', hook_event_name: 'SessionStart' });
check('leaves MEMORY.md untouched', parse(r) !== null && fs.readFileSync(memFile, 'utf8') === memBefore);
check('no MEMORY.md writing remains in the source', !HOOK_CODE.includes('MEMORY.md'));

// 7. Malformed stdin must never block a session from starting.
r = spawnHook('not json', { cwd: PROJ, env: hookEnv() });
check('malformed stdin → exit 0', r.status === 0);
check('malformed stdin → still valid JSON out', parse(r) !== null);

// ------------------------------------------------- gaps found by check:vacuity
//
// This hook runs at the start of every session and had the second-worst mutant
// survival rate in the repo (10/18 caught). Each case below is named with the
// line whose mutant survived.

// line 103 — `if (context.length > 0)`. Forced to `true`, the hook attaches a
// hookSpecificOutput carrying an EMPTY additionalContext. Every assertion still
// passed, because they all check what the context SAYS, never whether it should
// be there at all. An empty context block on every session is noise Claude has
// to read past.
{
    const bare = path.join(TMP, 'bare');
    fs.mkdirSync(bare, { recursive: true });
    const out = parse(run({ cwd: bare, session_id: 'b', hook_event_name: 'SessionStart' }, bare));
    check('no context to give: no hookSpecificOutput at all',
        out !== null && out.hookSpecificOutput === undefined);
    check('  but the banner is still emitted', typeof out?.systemMessage === 'string');
}

// line 48 — `if (fs.existsSync(prdPath))`. Forced to `true` on a project with no
// prd.json, the hook falls into the parse branch and reports "prd.json exists
// but failed to parse" for a file that does not exist — telling the user to fix
// something that is not there.
{
    const bare2 = path.join(TMP, 'bare2');
    fs.mkdirSync(bare2, { recursive: true });
    const out = parse(run({ cwd: bare2, session_id: 'b2', hook_event_name: 'SessionStart' }, bare2));
    const ctx = out?.hookSpecificOutput?.additionalContext || '';
    check('no prd.json: says nothing about prd.json', out !== null && !/prd\.json/.test(ctx));
}

// lines 62/63 — the "next pending stories" line, and the untitled fallback.
{
    const proj = path.join(TMP, 'stories');
    fs.mkdirSync(proj, { recursive: true });

    // All done: there is no next story, so the line must be absent entirely.
    fs.writeFileSync(path.join(proj, 'prd.json'), JSON.stringify({
        sprint: '1', stories: { 'S1-001': { title: 'a', passes: true } },
    }));
    let ctx = contextOf(run({ cwd: proj, session_id: 'x', hook_event_name: 'SessionStart' }, proj));
    check('nothing pending: no "next pending stories" line', ctx !== null && !/Next pending stories/.test(ctx));

    // A pending story with no title must read "untitled"; one with a title must
    // read its title. `s.title || 'untitled'` flipped to `&&` inverts both, and
    // testing only one of them cannot see it.
    fs.writeFileSync(path.join(proj, 'prd.json'), JSON.stringify({
        sprint: '1',
        stories: {
            'S1-001': { title: 'has a title', passes: null },
            'S1-002': { passes: null },
        },
    }));
    ctx = parse(run({ cwd: proj, session_id: 'y', hook_event_name: 'SessionStart' }, proj))
        ?.hookSpecificOutput?.additionalContext || '';
    check('a titled story shows its title', /S1-001 \(has a title\)/.test(ctx));
    check('an untitled story shows "untitled"', /S1-002 \(untitled\)/.test(ctx));
}

// lines 79/81 — the uncommitted-changes line. Both directions of the `if` and
// the singular/plural choice survived: the whole git branch was untested,
// because every fixture directory happened not to be a git repo.
{
    const repo = path.join(TMP, 'gitrepo');
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');

    // Clean tree → the line must be absent.
    let ctx = contextOf(run({ cwd: repo, session_id: 'g0', hook_event_name: 'SessionStart' }, repo));
    check('clean tree: no uncommitted-changes line', ctx !== null && !/uncommitted change/.test(ctx));

    // Exactly one change → singular.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    ctx = parse(run({ cwd: repo, session_id: 'g1', hook_event_name: 'SessionStart' }, repo))
        ?.hookSpecificOutput?.additionalContext || '';
    check('one change: reports it, in the singular', /1 uncommitted change at/.test(ctx));

    // Two changes → plural. Without both cases the `changes === 1` ternary can be
    // inverted without any assertion noticing.
    fs.writeFileSync(path.join(repo, 'b.txt'), 'y');
    ctx = parse(run({ cwd: repo, session_id: 'g2', hook_event_name: 'SessionStart' }, repo))
        ?.hookSpecificOutput?.additionalContext || '';
    check('two changes: reports them, in the plural', /2 uncommitted changes at/.test(ctx));
}

// ---------------------------------------------------------- plugin drift
// The 2026-08-18 incident: core ran 62 minor versions behind for two days with
// every layer green. The hook now surfaces two local signals — installed vs the
// marketplace clone's catalog, and the clone's own fetch age. Fixtures write a
// fake marketplace under HOME, which run() already redirects into TMP.
{
    const realVersion = JSON.parse(fs.readFileSync(
        path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    const bump = realVersion.split('.').map(Number);
    bump[1] += 1;
    const newerVersion = bump.join('.');

    const mkt = path.join(TMP, '.claude', 'plugins', 'marketplaces', 'testmkt');
    const catPath = path.join(mkt, '.claude-plugin', 'marketplace.json');
    fs.mkdirSync(path.dirname(catPath), { recursive: true });
    // The decoy sits FIRST and always claims a huge version: a real autodev
    // marketplace carries three plugins, so matching by anything weaker than
    // the exact name would compare core against a sibling's version. Every
    // assertion on exact versions below also asserts the decoy lost.
    const writeCatalog = (v) => fs.writeFileSync(catPath, JSON.stringify({
        name: 'testmkt',
        plugins: [{ name: 'autodev-decoy', version: '99.0.0' }, { name: 'autodev-core', version: v }],
    }));

    const proj = path.join(TMP, 'driftproj');
    fs.mkdirSync(proj, { recursive: true });
    const go = (id) => parse(run({ cwd: proj, session_id: id, hook_event_name: 'SessionStart' }, proj));

    // Catalog ahead of the install → both surfaces speak, with the versions and
    // the exact command. The verify reminder exists because the incident WAS a
    // /plugin update that reported nothing and changed nothing.
    writeCatalog(newerVersion);
    let out = go('d1');
    let ctx = out?.hookSpecificOutput?.additionalContext || '';
    check('catalog ahead: banner shows the update', (out?.systemMessage || '').includes(`update available: ${newerVersion}`));
    check('catalog ahead: context names installed and offered versions',
        ctx.includes(`v${realVersion}`) && ctx.includes(`v${newerVersion}`));
    check('catalog ahead: context carries the exact fix command', ctx.includes('/plugin update autodev-core'));
    check('catalog ahead: context says to verify the update took', /[Vv]erify/.test(ctx));

    // Same fixture path, version now equal → the drift lines must vanish. This
    // negative is known to reach the code because the case above just fired
    // through the identical path.
    writeCatalog(realVersion);
    out = go('d2');
    ctx = out?.hookSpecificOutput?.additionalContext || '';
    check('catalog equal: no update line in the banner',
        out !== null && !(out.systemMessage || '').includes('update available'));
    check('catalog equal: no update line in the context', out !== null && !ctx.includes('/plugin update'));

    // Catalog BEHIND the install (mid-publish, rolled back) is not an update.
    writeCatalog('0.0.1');
    out = go('d3');
    check('catalog behind: stays silent', out !== null && !(out.systemMessage || '').includes('update available'));

    // Fetch age. FETCH_HEAD older than a week → the clone stopped pulling, and
    // the "equal" verdict above is against a stale ceiling; say so.
    writeCatalog(realVersion);
    const fetchHead = path.join(mkt, '.git', 'FETCH_HEAD');
    fs.mkdirSync(path.dirname(fetchHead), { recursive: true });
    fs.writeFileSync(fetchHead, 'x');
    const old = (Date.now() - 10 * 86400000) / 1000;
    fs.utimesSync(fetchHead, old, old);
    ctx = go('d4')?.hookSpecificOutput?.additionalContext || '';
    check('stale clone: names the marketplace and the command',
        ctx.includes('testmkt') && ctx.includes('/plugin marketplace update testmkt'));

    // A fresh fetch must not warn.
    const now = Date.now() / 1000;
    fs.utimesSync(fetchHead, now, now);
    out = go('d5');
    ctx = out?.hookSpecificOutput?.additionalContext || '';
    check('fresh clone: no staleness line', out !== null && !ctx.includes('marketplace update'));

    // ---- THE REAL CATALOG SHAPE ----
    //
    // Every fixture above writes a per-plugin `version` field. `bump.js` never
    // produces one: it writes the version to marketplace.json's TOP-LEVEL
    // `metadata.version` and to each plugins/*/plugin.json, and leaves the
    // catalog's plugin entries carrying only name/source/description/keywords.
    //
    // So the suite invented a catalog format the real marketplace does not use,
    // and passed against it while the hook — which read `entry.version` and
    // bailed when it was missing — did nothing on every real session since the
    // block was written. [measured 2026-08-28] the installed catalog had
    // metadata.version "8.131.0" and not one plugin entry with a version.
    //
    // These cases use the shape bump.js actually writes.
    const writeRealCatalog = (v) => fs.writeFileSync(catPath, JSON.stringify({
        name: 'testmkt',
        metadata: { description: 'x', version: v },
        // No `version` on any entry — exactly as bump.js leaves them. The decoy
        // stays, so a hook matching by anything weaker than the exact name still
        // fails here.
        plugins: [{ name: 'autodev-decoy', source: './x' }, { name: 'autodev-core', source: './y' }],
    }));

    writeRealCatalog(newerVersion);
    out = go('d7');
    ctx = out?.hookSpecificOutput?.additionalContext || '';
    check('real catalog shape: the update line fires from metadata.version',
        (out?.systemMessage || '').includes(`update available: ${newerVersion}`));
    check('real catalog shape: context names both versions',
        ctx.includes(`v${realVersion}`) && ctx.includes(`v${newerVersion}`));

    // The negative, through the identical path, so the positive above cannot be
    // a hook that simply always speaks.
    writeRealCatalog(realVersion);
    out = go('d8');
    check('real catalog shape, equal version: silent',
        out !== null && !(out.systemMessage || '').includes('update available'));

    // Freshness lived AFTER the `continue` in the same loop body, so the missing
    // field took this check down with it. Assert it independently, on the real
    // shape, with no usable version anywhere.
    fs.writeFileSync(catPath, JSON.stringify({
        name: 'testmkt',
        plugins: [{ name: 'autodev-core', source: './y' }],
    }));
    const fh = path.join(mkt, '.git', 'FETCH_HEAD');
    fs.mkdirSync(path.dirname(fh), { recursive: true });
    fs.writeFileSync(fh, 'x');
    const stale = (Date.now() - 10 * 86400000) / 1000;
    fs.utimesSync(fh, stale, stale);
    ctx = go('d9')?.hookSpecificOutput?.additionalContext || '';
    check('no version anywhere: staleness is still reported',
        ctx.includes('/plugin marketplace update testmkt'));
    // And it must not invent an update out of a version it does not have. Note
    // the `if (catVersion)` guard in the subject is DEFENSIVE, not load-bearing:
    // parse(null) yields [NaN], which fails the length-3 test, so the silence
    // below holds with or without it. Recorded rather than dressed up as a kill.
    out = go('d10');
    check('no version anywhere: no update line invented',
        out !== null && !(out.systemMessage || '').includes('update available'));

    // Hand the fixture back exactly as it was found. The zero-bytes-when-clean
    // assertion further down shares this marketplace directory, and a stale
    // FETCH_HEAD left behind here makes it fail for a reason that has nothing to
    // do with what it is testing.
    const fresh = Date.now() / 1000;
    fs.utimesSync(fh, fresh, fresh);

    // A malformed catalog must never cost the session its banner.
    fs.writeFileSync(catPath, '{ not json');
    const r2 = run({ cwd: proj, session_id: 'd6', hook_event_name: 'SessionStart' }, proj);
    check('malformed catalog: exit 0, banner intact',
        r2.status === 0 && /^\[Auto-Dev v/.test(parse(r2)?.systemMessage || ''));

    // End-to-end zero-cost check: with the machinery present and everything
    // clean, a bare project still gets NO context block at all.
    writeCatalog(realVersion);
    const bare3 = path.join(TMP, 'bare3');
    fs.mkdirSync(bare3, { recursive: true });
    out = parse(run({ cwd: bare3, session_id: 'd7', hook_event_name: 'SessionStart' }, bare3));
    check('clean drift machinery adds zero bytes: no hookSpecificOutput',
        out !== null && out.hookSpecificOutput === undefined);
}

// ---- Parallel work surface ----
//
// The point of this block is the NEGATIVE case: a solitary clone must say
// nothing. A line that appears unconditionally would train every session to
// skip it, and then it is worse than absent. So each assertion below follows a
// specific state change, and the silence before it is asserted too.
{
    const gitp = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    const G = path.join(TMP, 'gitproj');
    const ORIGIN = path.join(TMP, 'origin.git');
    fs.mkdirSync(G, { recursive: true });

    gitp(['init', '-q', '-b', 'main'], G);
    gitp(['config', 'user.email', 'suite@example.invalid'], G);
    gitp(['config', 'user.name', 'suite'], G);
    gitp(['config', 'commit.gpgsign', 'false'], G);
    fs.writeFileSync(path.join(G, 'f.txt'), 'one\n');
    gitp(['add', '.'], G);
    gitp(['commit', '-q', '-m', 'init'], G);
    gitp(['init', '-q', '--bare', ORIGIN], TMP);
    gitp(['remote', 'add', 'origin', ORIGIN], G);
    gitp(['push', '-q', 'origin', 'main'], G);

    const ctxOf = (cwd, id) =>
        parse(run({ cwd, session_id: id, hook_event_name: 'SessionStart' }, cwd))
            ?.hookSpecificOutput?.additionalContext || '';

    // Known-positive that the fixture is real: git must actually be usable here.
    check('parallel: the git fixture built (control)',
        gitp(['rev-parse', '--show-toplevel'], G).status === 0);

    const solitary = contextOf(run({ cwd: G, session_id: 'p1', hook_event_name: 'SessionStart' }, G));
    check('a solitary clone emits no parallel-work line',
        solitary !== null && !solitary.includes('Parallel work'));

    // One unmerged branch on the remote.
    gitp(['checkout', '-q', '-b', 'feature/x'], G);
    fs.writeFileSync(path.join(G, 'f.txt'), 'two\n');
    gitp(['commit', '-qam', 'x'], G);
    gitp(['push', '-q', 'origin', 'feature/x'], G);
    gitp(['checkout', '-q', 'main'], G);

    let ctx = ctxOf(G, 'p2');
    check('an unmerged origin branch is counted, singular',
        /1 origin branch not merged into main/.test(ctx));
    check('and it names the authoritative check rather than implying freshness',
        ctx.includes('as of the last fetch') && ctx.includes('git ls-remote --heads origin'));

    // A sibling worktree.
    const WT = path.join(TMP, 'wt-sibling');
    gitp(['worktree', 'add', '-q', WT, 'feature/x'], G);

    ctx = ctxOf(G, 'p3');
    check('a sibling worktree is counted and named',
        /1 other worktree \(feature\/x\)/.test(ctx));

    ctx = ctxOf(WT, 'p4');
    check('a worktree reports its sibling, never itself',
        /1 other worktree \(main\)/.test(ctx));

    // Removing it must remove the claim — a count that only ever grows is not
    // measuring anything.
    gitp(['worktree', 'remove', '--force', WT], G);
    ctx = ctxOf(G, 'p5');
    check('removing the worktree drops the worktree clause',
        !ctx.includes('other worktree') && /1 origin branch not merged/.test(ctx));

    // A directory that is not a repo at all must stay silent and exit 0.
    const NOTGIT = path.join(TMP, 'notgit');
    fs.mkdirSync(NOTGIT, { recursive: true });
    const rp = run({ cwd: NOTGIT, session_id: 'p6', hook_event_name: 'SessionStart' }, NOTGIT);
    const notgitCtx = contextOf(rp);
    check('a non-repo directory: exit 0, no parallel-work line',
        rp.status === 0 && notgitCtx !== null && !notgitCtx.includes('Parallel work'));
    check('a non-repo directory writes nothing to stderr', rp.stderr === '');
}

// ---- Session pile ----
// A planted store, never the operator's real one: every run below points
// SESSION_SWEEP_STORE at it, over hookEnv()'s empty default. The population is
// built so each filter has a record it must reject: archived, another repo, and
// a stale mtime.
{
    const STORE = path.join(TMP, 'pile-store', 'ws', 'sub');
    fs.mkdirSync(STORE, { recursive: true });
    const OTHER = path.join(TMP, 'other-repo');
    let n = 0;
    const plant = (extra, ageDays = 0) => {
        const rec = { sessionId: `local_pile-${n++}`, isArchived: false, originCwd: PROJ, cwd: PROJ, ...extra };
        const f = path.join(STORE, `${rec.sessionId}.json`);
        fs.writeFileSync(f, JSON.stringify(rec), 'utf8');
        if (ageDays) { const t = new Date(Date.now() - ageDays * 86400000); fs.utimesSync(f, t, t); }
    };
    for (let i = 0; i < 6; i++) plant({});
    plant({ cliSessionId: 'me-pile' });                    // 7th live record: the caller itself
    for (let i = 0; i < 3; i++) plant({ isArchived: true });
    for (let i = 0; i < 5; i++) plant({ originCwd: OTHER, cwd: OTHER });
    for (let i = 0; i < 2; i++) plant({}, 30);              // live but untouched for 30 days

    const pile = (id, extraEnv, extraPayload) => {
        const res = run({ cwd: PROJ, session_id: id, hook_event_name: 'SessionStart', ...extraPayload }, PROJ,
            { SESSION_SWEEP_STORE: path.join(TMP, 'pile-store'), AUTODEV_SESSION_PILE_MAX: '', ...extraEnv });
        const out = parse(res);
        return { res, out, ctx: out?.hookSpecificOutput?.additionalContext || '' };
    };

    const a = pile('someone-else');
    check('pile: above the threshold, the line names the count and threshold',
        /Session pile: 7 other live sessions/.test(a.ctx) && a.ctx.includes('(threshold 6)'));
    const b = pile('me-pile');
    check('pile: the calling session is not counted, so 6 is silent at threshold 6',
        b.out !== null && !b.ctx.includes('Session pile') && b.res.status === 0);
    const c = pile('someone-else', { AUTODEV_SESSION_PILE_MAX: '10' });
    check('pile: the threshold is read from AUTODEV_SESSION_PILE_MAX (control)',
        c.out !== null && !c.ctx.includes('Session pile'));
    const d = pile('someone-else', { SESSION_SWEEP_STORE: path.join(TMP, 'no-such-store') });
    check('pile: an unreadable store says nothing and exits 0',
        d.out !== null && !d.ctx.includes('Session pile') && d.res.status === 0 && d.res.stderr === '');

    const { countLivePile } = require(path.join(PLUGIN_ROOT, 'scripts', 'session-pile.js'));
    const direct = countLivePile(PROJ, { store: path.join(TMP, 'pile-store') });
    check('pile: archived, other-repo and stale records are all excluded (7 of 17 scanned)',
        direct && direct.count === 7 && direct.scanned === 17);
    check('pile: an unreadable store is null, not zero',
        countLivePile(PROJ, { store: path.join(TMP, 'no-such-store') }) === null);

    // The hook counts after the sections below it have run, into a slot held
    // at this point, so its line still comes before the compaction pointer.
    // The session's own handoff, the name context-depth-nudge.js gives it: a
    // root RESUME.md is not a pointer once only the session's own file counts.
    const OWN = path.join(PROJ, '.claude', 'handoffs', 'RESUME-someone-.md');
    fs.mkdirSync(path.dirname(OWN), { recursive: true });
    fs.writeFileSync(OWN, '# resume\n', 'utf8');
    const e = pile('someone-else', {}, { source: 'compact' });
    fs.rmSync(OWN, { force: true });
    const at = (s) => e.ctx.indexOf(s);
    check('pile: the line keeps its place, before the compaction pointer',
        at('Session pile: 7') >= 0 && at('Context was just compacted') > at('Session pile: 7'));

    // [measured 2026-09-24] 31 live records were pretty-printed, and a head
    // pattern with no whitespace sent each one to a full parse.
    const { countLivePileAsync, parseHead } = require(path.join(PLUGIN_ROOT, 'scripts', 'session-pile.js'));
    const ph = parseHead(JSON.stringify({ isArchived: false, cwd: PROJ, cliSessionId: 'c-1' }, null, 2));
    check('pile: the head patterns allow whitespace around the colon',
        !!ph && ph.isArchived === false && ph.cwd === PROJ && ph.cliSessionId === 'c-1');
    const PRETTY = path.join(TMP, 'pile-pretty', 'ws');
    fs.mkdirSync(PRETTY, { recursive: true });
    const put = (name, rec, space) => fs.writeFileSync(path.join(PRETTY, `${name}.json`), JSON.stringify(rec, null, space), 'utf8');
    put('local_pretty', { sessionId: 'local_pretty', isArchived: false, originCwd: PROJ }, 2);
    // Fields past the head: only a full parse answers these two.
    put('local_deep', { sessionId: 'local_deep', pad: 'x'.repeat(9000), isArchived: false, originCwd: PROJ });
    put('local_deeparch', { sessionId: 'local_deeparch', pad: 'x'.repeat(9000), isArchived: true, originCwd: PROJ });
    const pretty = countLivePile(PROJ, { store: path.join(TMP, 'pile-pretty') });
    check('pile: a pretty-printed record is read from its head, and only records with their fields past it are parsed in full',
        !!pretty && pretty.count === 2 && pretty.scanned === 3 && pretty.fullParses === 2);

    // The hook uses the async count, and the sync one is its reference.
    later.push(async () => {
        const same = (a, s) => !!a && !!s && a.count === s.count && a.scanned === s.scanned && a.fullParses === s.fullParses;
        for (const store of [path.join(TMP, 'pile-store'), path.join(TMP, 'pile-pretty')]) {
            const s = countLivePile(PROJ, { store, excludeCliSessionId: 'me-pile' });
            const got = [];
            for (const parallel of [1, 3, undefined]) got.push(await countLivePileAsync(PROJ, { store, excludeCliSessionId: 'me-pile', parallel }));
            check(`pile: the async count equals the sync one at widths 1, 3 and the default (${path.basename(store)}: ${s && s.count})`,
                got.every((a) => same(a, s)));
        }
        check('pile: the async count of an unreadable store is null too',
            (await countLivePileAsync(PROJ, { store: path.join(TMP, 'no-such-store') })) === null);

        // One open handle per record would meet a 256-descriptor limit as
        // EMFILE, which the per-record catch turns into a silent undercount.
        const realOpen = fs.promises.open;
        let open = 0;
        let peak = 0;
        fs.promises.open = async (...args) => {
            const fh = await realOpen.apply(fs.promises, args);
            peak = Math.max(peak, ++open);
            const close = fh.close.bind(fh);
            fh.close = () => { open--; return close(); };
            return fh;
        };
        let bounded;
        try { bounded = await countLivePileAsync(PROJ, { store: path.join(TMP, 'pile-store'), parallel: 3 }); } finally { fs.promises.open = realOpen; }
        check(`pile: the async count holds at most \`parallel\` records open at once (peak ${peak} of 3)`,
            !!bounded && bounded.count === 7 && peak >= 1 && peak <= 3);
    });
}

// ---- The store every other run reads is the suite's, not the machine's ----
//
// A real store cannot be planted: records written into the operator's store
// would show up in their Desktop app. So the ambient variables this process
// passes on are pointed at planted stores instead, standing in for the real
// paths. Each store holds a distinct number of live records for PROJ, and
// AUTODEV_SESSION_PILE_MAX=0 makes a single counted record print the line, so
// the line's count names which store leaked. Each control runs the hook with
// the env run() used before hookEnv(), and proves its plant is reachable.
{
    const plantLive = (dir, n) => {
        fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < n; i++) {
            const rec = { sessionId: `local_ambient-${n}-${i}`, isArchived: false, originCwd: PROJ, cwd: PROJ };
            fs.writeFileSync(path.join(dir, `${rec.sessionId}.json`), JSON.stringify(rec), 'utf8');
        }
    };
    const AMBIENT = path.join(TMP, 'ambient');
    const SWEEP = path.join(AMBIENT, 'sweep');
    const BASE = path.join(AMBIENT, 'base');
    plantLive(SWEEP, 3);
    plantLive(path.join(BASE, 'Claude', 'claude-code-sessions'), 4);

    const withAmbient = (vars, fn) => {
        const saved = {};
        for (const k of Object.keys(vars)) saved[k] = process.env[k];
        const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
        try {
            for (const [k, v] of Object.entries(vars)) put(k, v);
            return fn();
        } finally {
            for (const [k, v] of Object.entries(saved)) put(k, v);
        }
    };
    const payload = { cwd: PROJ, session_id: 'ambient', hook_event_name: 'SessionStart' };
    // Each read is null when the hook printed no JSON, and every absence check
    // below requires it not to be.
    const unisolated = () => contextOf(spawnHook(JSON.stringify(payload), {
        cwd: PROJ,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HOME: TMP, USERPROFILE: TMP,
            CLAUDE_CONFIG_DIR: path.join(TMP, '.claude'), AUTODEV_SESSION_PILE_MAX: '0' },
    }));
    const isolated = (extraEnv = {}) => contextOf(run(payload, PROJ, { AUTODEV_SESSION_PILE_MAX: '0', ...extraEnv }));

    // The empty store gives a count of 0, and 0 > 0 is false: no line.
    const a = withAmbient({ SESSION_SWEEP_STORE: SWEEP }, () => ({ leak: unisolated(), run: isolated() }));
    check('store isolation (control): an ambient SESSION_SWEEP_STORE is read by the old env',
        /Session pile: 3 other live sessions/.test(a.leak));
    check('store isolation: run() reads zero records from an ambient SESSION_SWEEP_STORE',
        a.run !== null && !a.run.includes('Session pile'));

    // With SESSION_SWEEP_STORE gone, as for a reader that never knew it, the
    // hook falls back to the platform base dir. macOS resolves it from HOME,
    // which run() always pointed at TMP, so only win32 and Linux could leak.
    const baseVars = { SESSION_SWEEP_STORE: undefined, APPDATA: BASE, LOCALAPPDATA: BASE, XDG_CONFIG_HOME: BASE };
    const b = withAmbient(baseVars, () => ({ leak: unisolated(), run: isolated({ SESSION_SWEEP_STORE: undefined }) }));
    if (process.platform === 'darwin') {
        check('store isolation (control, darwin): the base dir is under HOME, so the old env did not leak',
            b.leak !== null && !b.leak.includes('Session pile'));
    } else {
        check('store isolation (control): an ambient APPDATA or XDG_CONFIG_HOME is read by the old env',
            /Session pile: 4 other live sessions/.test(b.leak));
    }
    check('store isolation: without SESSION_SWEEP_STORE, run() still reads zero records from the ambient base dirs',
        b.run !== null && !b.run.includes('Session pile'));
}

// ---- Apps no gate covers ----
//
// A nested app that no CI step, git hook or root gate script reaches is named
// once, with what it is missing and what is at risk. Wired into the root gate,
// the line goes away; outside a git repository the check does not run at all.
// The red and the green are the same repository, one script apart.
{
    const UG = path.join(TMP, 'ungated');
    const put = (rel, body) => {
        fs.mkdirSync(path.dirname(path.join(UG, rel)), { recursive: true });
        fs.writeFileSync(path.join(UG, rel), typeof body === 'string' ? body : JSON.stringify(body));
    };
    // The root has no gate-named script, so the root app is ungated too, and
    // the hook must still name only the nested one.
    const rootPkg = { name: 'shop', scripts: { dev: 'next dev', build: 'next build' }, dependencies: { next: '15' } };
    put('package.json', rootPkg);
    put('apps/admin/package.json', { name: 'admin', scripts: { dev: 'next dev' } });
    put('apps/admin/middleware.ts', 'export const m = (req) => req.cookies.get(process.env.DATABASE_URL);\n');
    spawnSync('git', ['init', '-q'], { cwd: UG, windowsHide: true });
    const payload = { cwd: UG, session_id: 'ungated', hook_event_name: 'SessionStart' };

    const red = contextOf(run(payload, UG));
    check('ungated apps: a nested app no gate reaches is named, with the population',
        red !== null && /Ungated apps: 1 of 2 apps in this repository/.test(red) && red.includes('apps/admin'));
    check('ungated apps: the line says what is missing and what is at risk',
        red !== null && red.includes('missing CI and tests; at risk: database, cookies, auth'));
    check('ungated apps: the line names the command that prints the detail',
        red !== null && red.includes('check-ungated-apps.js'));
    check('ungated apps: the root app is never named, even with no gate of its own',
        red !== null && (red.match(/\(missing /g) || []).length === 1);

    put('package.json', Object.assign({}, rootPkg, { scripts: Object.assign({}, rootPkg.scripts, { gate: 'npm run build && npm --prefix apps/admin run build' }) }));
    const green = contextOf(run(payload, UG));
    check('ungated apps: once a root gate script reaches the app, the hook adds nothing',
        green !== null && !green.includes('Ungated apps'));

    put('package.json', rootPkg);
    fs.rmSync(path.join(UG, '.git'), { recursive: true, force: true });
    const notRepo = contextOf(run(payload, UG));
    check('ungated apps: outside a git repository the check does not run',
        notRepo !== null && !notRepo.includes('Ungated apps'));
}

(async () => {
    for (const fn of later) await fn();

    // The zero reads above rest on the store dir staying empty, so this runs
    // after the async checks too. A hook that wrote into APPDATA, LOCALAPPDATA
    // or XDG_CONFIG_HOME would land here.
    check('store isolation: the empty store is still empty after every run',
        fs.readdirSync(EMPTY_STORE).length === 0);

    let pass = 0, fail = 0, skipped = 0;
    for (const [label, ok, lost] of cases) {
        if (lost) {
            skipped++;
            console.log('SKIP  ' + label + '  (not graded: ' + lost + ')');
            continue;
        }
        console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
        ok ? pass++ : fail++;
    }
    const lost = sb.lostVerdict();
    console.log(`\n${sb.tally(pass, fail, lost ? 1 : 0)}`);
    if (lost) console.log(`INDETERMINATE: ${lost}. The ${skipped} cases after it were not graded.`);

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

    process.exitCode = sb.exitCode(fail, lost ? 1 : 0);
})();
