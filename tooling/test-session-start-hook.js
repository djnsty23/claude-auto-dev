#!/usr/bin/env node
// Tests for autodev-core's SessionStart hook.
//
// The hook previously emitted plain stdout and did two things that could not
// work: it parsed .env.local into process.env (a hook cannot set environment
// variables for the session — the values died with the hook process, while it
// still printed "[Env] .env.local loaded"), and it rewrote the version number
// inside the user's own MEMORY.md. Both are asserted gone here.
//
// Run: node tooling/test-session-start-hook.js

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const check = (label, ok) => cases.push([label, ok]);

function run(payload, cwd = PROJ) {
    return spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        cwd,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HOME: TMP, USERPROFILE: TMP },
    });
}

function parse(r) {
    try { return JSON.parse(r.stdout); } catch { return null; }
}

// 1. No prd.json — banner only, still valid JSON.
let r = run({ cwd: PROJ, session_id: 's1', hook_event_name: 'SessionStart' });
let out = parse(r);
check('exits 0 with no prd.json', r.status === 0);
check('emits valid JSON', out !== null);
check('emits a version banner as systemMessage', /^\[Auto-Dev v/.test(out?.systemMessage || ''));
check('reports the real version, not a hardcoded fallback', !/v\?\]/.test(out?.systemMessage || ''));

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
check('does not claim to have loaded .env.local', !whole.includes('.env.local loaded'));
check('does not echo secrets from .env.local', !whole.includes('sk_live_should_never_be_touched'));
check('no .env.local parsing remains in the source', !HOOK_CODE.includes('.env.local'));

// 6. Regression: the user's MEMORY.md must not be rewritten.
const memDir = path.join(TMP, '.claude', 'projects', 'encoded-proj', 'memory');
fs.mkdirSync(memDir, { recursive: true });
const memFile = path.join(memDir, 'MEMORY.md');
const memBefore = '## Project: demo (v1.0)\n\nnotes\n';
fs.writeFileSync(memFile, memBefore);
run({ cwd: PROJ, session_id: 's6', hook_event_name: 'SessionStart' });
check('leaves MEMORY.md untouched', fs.readFileSync(memFile, 'utf8') === memBefore);
check('no MEMORY.md writing remains in the source', !HOOK_CODE.includes('MEMORY.md'));

// 7. Malformed stdin must never block a session from starting.
r = spawnSync(process.execPath, [HOOK], {
    input: 'not json', encoding: 'utf8', cwd: PROJ,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HOME: TMP, USERPROFILE: TMP },
});
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
    check('no prd.json: says nothing about prd.json', !/prd\.json/.test(ctx));
}

// lines 62/63 — the "next pending stories" line, and the untitled fallback.
{
    const proj = path.join(TMP, 'stories');
    fs.mkdirSync(proj, { recursive: true });

    // All done: there is no next story, so the line must be absent entirely.
    fs.writeFileSync(path.join(proj, 'prd.json'), JSON.stringify({
        sprint: '1', stories: { 'S1-001': { title: 'a', passes: true } },
    }));
    let ctx = parse(run({ cwd: proj, session_id: 'x', hook_event_name: 'SessionStart' }, proj))
        ?.hookSpecificOutput?.additionalContext || '';
    check('nothing pending: no "next pending stories" line', !/Next pending stories/.test(ctx));

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
    let ctx = parse(run({ cwd: repo, session_id: 'g0', hook_event_name: 'SessionStart' }, repo))
        ?.hookSpecificOutput?.additionalContext || '';
    check('clean tree: no uncommitted-changes line', !/uncommitted change/.test(ctx));

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
    check('catalog equal: no update line in the banner', !(out?.systemMessage || '').includes('update available'));
    check('catalog equal: no update line in the context', !ctx.includes('/plugin update'));

    // Catalog BEHIND the install (mid-publish, rolled back) is not an update.
    writeCatalog('0.0.1');
    out = go('d3');
    check('catalog behind: stays silent', !(out?.systemMessage || '').includes('update available'));

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
    ctx = go('d5')?.hookSpecificOutput?.additionalContext || '';
    check('fresh clone: no staleness line', !ctx.includes('marketplace update'));

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
        !(out?.systemMessage || '').includes('update available'));

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
    check('no version anywhere: no update line invented',
        !(go('d10')?.systemMessage || '').includes('update available'));

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

    check('a solitary clone emits no parallel-work line',
        !ctxOf(G, 'p1').includes('Parallel work'));

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
    check('a non-repo directory: exit 0, no parallel-work line',
        rp.status === 0 && !(parse(rp)?.hookSpecificOutput?.additionalContext || '').includes('Parallel work'));
    check('a non-repo directory writes nothing to stderr', rp.stderr === '');
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

process.exit(fail > 0 ? 1 : 0);
