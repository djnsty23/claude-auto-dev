#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/recheck-passed.js.
//
// The tool samples a few stories at passes: true each week so a second pass
// can re-verify them, and records each disagreement as a new case. Every case
// here builds real git repos with real prd.json files in a temp directory.
//
// Acceptance, named before the tool was written:
//   R1  sample picks at most --per-week stories, only ones at passes: true,
//       spread across repos, and prints the population it drew from
//   R2  a second sample in the same week adds nothing, and a story sampled in
//       the last 12 weeks is not drawn again in a later week
//   R3  a shipped sha that is not on the default branch is flagged, and a
//       passed story with no evidence field is flagged
//   R4  verdict --disagree closes the sample and appends a case, --agree closes
//       it with no case, and a verdict on nothing open exits 1
//   R5  worktrees of one repo count once, and an empty population exits 2
//   R6  --selftest derives its negatives from a real passed story, writes them
//       apart from the real ledger, and exits 2 when no positive control exists

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'recheck-passed.js');
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
    if (ok) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recheck-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function initRepo(dir) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'one');
    return git(dir, 'rev-parse', 'HEAD');
}
function repo(code, name, stories) {
    const dir = path.join(code, name);
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify({ stories }, null, 2));
    return dir;
}

function run(args, { state, code = path.join(tmp, 'code'), now } = {}) {
    const env = { ...process.env, AUTODEV_CODE_DIR: code, RECHECK_STATE_DIR: state };
    if (now) env.RECHECK_NOW = now;
    const r = spawnSync(process.execPath, [TOOL, ...args], { env, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const ledger = (state) => {
    const p = path.join(state, 'ledger.jsonl');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const samples = (state) => ledger(state).filter((r) => r.type === 'sample');

// Three repos with 6, 4 and 2 passed stories, plus one story in every other state.
const others = { p1: { title: 'pending', passes: null }, f1: { title: 'failed', passes: false },
    d1: { title: 'deferred', passes: 'deferred' }, n1: { title: 'blocked', passes: 'needs-setup' } };
const passed = (prefix, n) => Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [`${prefix}${i + 1}`, { title: `${prefix} story ${i + 1}`, passes: true, verify: 'npm test' }]));
const CODE = path.join(tmp, 'code');
const alpha = repo(CODE, 'alpha', { ...passed('a', 6), ...others });
repo(CODE, 'beta', { ...passed('b', 4), ...others });
repo(CODE, 'gamma', { ...passed('g', 2), ...others });
// A worktree of alpha with the same prd.json: it must count once.
git(alpha, 'add', 'prd.json');
git(alpha, 'commit', '-q', '-m', 'prd');
git(alpha, 'worktree', 'add', '-q', path.join(CODE, 'alpha-wt'));

const W45 = '2026-11-04T12:00:00Z';
const W46 = '2026-11-11T12:00:00Z';

// ---- R1, R5 -----------------------------------------------------------------
{
    const state = path.join(tmp, 's1');
    const r = run(['sample', '--per-week', '5'], { state, now: W45 });
    const s = samples(state);
    check('R1 sample exits 0', r.code === 0, r.out);
    check('  picks 5 stories', s.length === 5, String(s.length));
    check('  only stories at passes: true', s.every((x) => /^[abg]\d$/.test(x.id)), s.map((x) => x.id).join());
    check('  spread across all three repos', new Set(s.map((x) => path.basename(x.repo))).size === 3,
        s.map((x) => path.basename(x.repo)).join());
    check('  prints the population (12 passed in 3 repos)', /12 passed stories across 3 repos/.test(r.out), r.out);
    check('R5 the worktree is not a fourth repo', !s.some((x) => /alpha-wt/.test(x.repo)), s.map((x) => x.repo).join());

    // ---- R2 -----------------------------------------------------------------
    const again = run(['sample', '--per-week', '5'], { state, now: W45 });
    check('R2 a second sample in the same week adds nothing', samples(state).length === 5 && again.code === 0, again.out);
    const later = run(['sample', '--per-week', '5'], { state, now: W46 });
    const s2 = samples(state);
    const ids = s2.map((x) => x.repo + ':' + x.id);
    check('  a later week draws new stories only', s2.length === 10 && new Set(ids).size === 10, later.out);
    const seeded = path.join(tmp, 's1b');
    run(['sample', '--per-week', '5'], { state: seeded, now: W45 });
    check('  the draw is reproducible for a week', samples(seeded).map((x) => x.id).join() === s.map((x) => x.id).join());

    // ---- R4 -----------------------------------------------------------------
    const first = s[0], second = s[1];
    const d = run(['verdict', `${path.basename(first.repo)}:${first.id}`, '--disagree', '--note', 'test fails on main'], { state, now: W46 });
    const cases = path.join(state, 'cases.jsonl');
    const caseText = () => (fs.existsSync(cases) ? fs.readFileSync(cases, 'utf8') : '');
    check('R4 --disagree exits 0', d.code === 0, d.out);
    check('  appends a case naming the story and the note', /test fails on main/.test(caseText()) && caseText().includes(first.id));
    const a = run(['verdict', `${path.basename(second.repo)}:${second.id}`, '--agree'], { state, now: W46 });
    check('  --agree exits 0 and adds no case', a.code === 0 && caseText().trim().split('\n').length === 1, a.out);
    const none = run(['verdict', 'alpha:zz9', '--agree'], { state, now: W46 });
    check('  a verdict on nothing open exits 1', none.code === 1, none.out);
    const st = run(['status', '--json'], { state, now: W46 });
    let open = null;
    try { open = JSON.parse(st.out).open; } catch { /* reported below */ }
    check('  status lists the 8 still open', Array.isArray(open) && open.length === 8, st.out.slice(0, 200));
}

// ---- R3 ---------------------------------------------------------------------
{
    const code = path.join(tmp, 'code3');
    const dir = path.join(code, 'delta');
    const onMain = initRepo(dir);
    git(dir, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', 'b.txt');
    git(dir, 'commit', '-q', '-m', 'side');
    const offMain = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'prd.json'), JSON.stringify({ stories: {
        ok1: { title: 'shipped on main', passes: true, shippedSha: onMain },
        off1: { title: 'shipped off main', passes: true, shippedSha: offMain },
        gone1: { title: 'sha not in repo', passes: true, shippedSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        bare1: { title: 'no evidence at all', passes: true },
    } }));
    const state = path.join(tmp, 's3');
    const r = run(['sample', '--per-week', '5'], { state, code, now: W45 });
    const by = Object.fromEntries(samples(state).map((x) => [x.id, x.flags || []]));
    check('R3 a sha on the default branch is not flagged', Array.isArray(by.ok1) && by.ok1.length === 0, JSON.stringify(by));
    check('  a sha off the default branch is flagged', (by.off1 || []).includes('sha-not-on-default'), JSON.stringify(by));
    check('  a sha missing from the repo is flagged', (by.gone1 || []).includes('sha-missing'), JSON.stringify(by));
    check('  a story with no evidence is flagged', (by.bare1 || []).includes('no-evidence'), JSON.stringify(by));
    check('  the flag count is printed', /3 flagged/.test(r.out), r.out);
}

// ---- R5 empty ---------------------------------------------------------------
{
    const code = path.join(tmp, 'empty');
    fs.mkdirSync(code);
    const r = run(['sample'], { state: path.join(tmp, 's5'), code, now: W45 });
    check('R5 an empty population exits 2', r.code === 2, r.out);
}

// ---- R6 ---------------------------------------------------------------------
{
    const state = path.join(tmp, 's6');
    const r = run(['--selftest'], { state, now: W45 });
    check('R6 --selftest passes on a real population', r.code === 0, r.out);
    check('  and names the story it derived from', /derived from \S+:\S+/.test(r.out), r.out);
    check('  and writes nothing to the real ledger', ledger(state).length === 0);
    const code = path.join(tmp, 'nopass');
    repo(code, 'eps', others);
    const n = run(['--selftest'], { state: path.join(tmp, 's6b'), code, now: W45 });
    check('  exits 2 with no passed story to derive from', n.code === 2, n.out);
}

{
    const h = run(['--help'], { state: path.join(tmp, 'h') });
    check('--help returns usage', h.code === 0 && /usage/i.test(h.out), h.out);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
