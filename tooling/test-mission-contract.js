#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/mission-contract.js.
//
// The property it exists for: the same story at the same base gives the same
// bytes, and a changed acceptance criterion gives a different contract that the
// store refuses under the original eventId. Also: the five prd states are kept
// apart (done, deferred and needs-setup are refused; pending and failed are
// admitted), and every malformed input is a named refusal, never a payload.
//
// The last group drives the real mission-store.js and runs only where the store
// runs (node:sqlite plus POSIX ownership checks); elsewhere it says so by name.
//
// Run: node tooling/test-mission-contract.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'mission-contract.js');
const STORE = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'mission-store.js');
// realpathSync.native, not realpathSync: Windows runners hand out an 8.3 temp dir
// (C:\Users\RUNNER~1\...) that only the native resolver expands to what git reports.
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'mission-contract-'));

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) { passed++; return; }
    failures.push(name + (detail === undefined ? '' : '\n      -> ' + String(detail).slice(0, 400)));
}

function run(args, opts = {}) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', cwd: opts.cwd || ROOT, timeout: 15000 });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* usage text or garbage */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}
// The store canonicalises what it records and replays (sorted keys), so equality
// is by shape, never by the key order the builder happened to emit.
function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
}
function storeCli(command, store, payload) {
    const r = spawnSync(process.execPath, [STORE, command, '--store', store], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// ---- fixture repository and prd files ----------------------------------------
const repo = path.join(ROOT, 'repo');
fs.mkdirSync(repo);
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(ROOT, 'no-hooks'), '-c', 'commit.gpgSign=false', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git('init', '-q');
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
git('add', 'README.md');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
const HEAD = git('rev-parse', 'HEAD');
const realRepo = fs.realpathSync.native(repo);

const criterion = 'A tooltip near the viewport edge\n  stays fully visible,\t and the pointer\n\n keeps pointing at its anchor.';
const stories = {
    'S1': { id: 'S1', title: 'Tooltip clipping', passes: null, notes: criterion },
    'S2': { id: 'S2', title: 'Done already', passes: true, notes: 'Was verified last sprint.' },
    'S3': { id: 'S3', title: 'Deferred', passes: 'deferred', notes: 'A decision not to do it.' },
    'S4': { id: 'S4', title: 'Blocked on a key', passes: 'needs-setup', notes: 'Needs the vendor API key.' },
    'S5': { id: 'S5', title: 'Failed last time', passes: false, notes: 'Retry: the export completes in under two seconds.' },
    'S6': { id: 'S6', title: 'No criterion', passes: null, notes: '   \n ' },
    'S7': { id: 'S7', title: 'Too long', passes: null, notes: 'x'.repeat(2049) },
    'S8': { id: 'S8', title: 'Absent passes counts as pending', notes: 'Reload keeps the draft.' },
};
const prdFlat = path.join(ROOT, 'prd.json');
fs.writeFileSync(prdFlat, JSON.stringify({ stories }, null, 2));
const prdNested = path.join(ROOT, 'prd-nested.json');
fs.writeFileSync(prdNested, JSON.stringify({ sprints: [
    { name: 'sprint 1', stories: { 'N1': { id: 'N1', title: 'Old sprint, still open', passes: null, notes: 'The earlier endpoint answers 200 with the fixture body.' } } },
    { name: 'sprint 2', stories: { 'N2': { id: 'N2', title: 'Newest sprint, done', passes: true, notes: 'Done.' } } },
] }, null, 2));
const base = ['--prd', prdFlat, '--root', repo];

// ---- help and usage -----------------------------------------------------------
{
    const h = run(['--help']);
    check('--help exits 0 and prints usage', h.status === 0 && /^Usage: node mission-contract\.js/.test(h.stdout), h.stdout.slice(0, 120));
    const none = run([]);
    check('no arguments prints usage and exits 0 (an entry point must return)', none.status === 0 && /Usage/.test(none.stdout), none.stdout.slice(0, 120));
    const missing = run(['--prd', prdFlat, '--story', 'S1']);
    check('missing --paths is a usage refusal', missing.status === 1 && missing.json && missing.json.ok === false && missing.json.error.code === 'usage', missing.stdout);
    check('  and the message names the flag', missing.json && /--paths/.test(missing.json.error.message), missing.json && missing.json.error.message);
    const unknown = run([...base, '--story', 'S1', '--paths', 'src/', '--bogus', 'x']);
    check('an unknown flag is a usage refusal, not silently ignored', unknown.status === 1 && unknown.json && unknown.json.error.code === 'usage', unknown.stdout);
}

// ---- the payload for a pending story ------------------------------------------
let s1;
{
    const r = run([...base, '--story', 'S1', '--paths', 'src/tooltip/,src/index.ts']);
    check('a pending story yields a payload, exit 0', r.status === 0 && r.json && r.json.contract, r.stdout + r.stderr);
    s1 = r.json;
    check('missionId defaults to the story id', s1 && s1.missionId === 'S1', s1 && s1.missionId);
    check('eventId defaults to admit:<story id>', s1 && s1.eventId === 'admit:S1', s1 && s1.eventId);
    check('base is the repository HEAD', s1 && s1.contract.repo.baseSha === HEAD, s1 && s1.contract.repo.baseSha);
    check('root is the real, canonical toplevel', s1 && s1.contract.repo.root === realRepo, s1 && s1.contract.repo.root);
    check('commonDir is the real git dir', s1 && s1.contract.repo.commonDir === fs.realpathSync.native(path.join(repo, '.git')), s1 && s1.contract.repo.commonDir);
    check('repo id falls back to the basename when there is no origin', s1 && s1.contract.repo.id === 'repo', s1 && s1.contract.repo.id);
    check('paths are split and kept in order', s1 && JSON.stringify(s1.contract.scope.paths) === JSON.stringify(['src/tooltip/', 'src/index.ts']), s1 && JSON.stringify(s1.contract.scope.paths));
    check('effects default to read,write', s1 && JSON.stringify(s1.contract.scope.effects) === JSON.stringify(['read', 'write']));
    check('target defaults to local:<repo id>', s1 && s1.contract.target.kind === 'local' && s1.contract.target.identifier === 'repo', s1 && JSON.stringify(s1.contract.target));
    check('the acceptance criterion is the story notes, whitespace-normalised', s1 && s1.contract.acceptance.length === 1 && s1.contract.acceptance[0].id === 'S1'
        && s1.contract.acceptance[0].description === 'A tooltip near the viewport edge stays fully visible, and the pointer keeps pointing at its anchor.', s1 && JSON.stringify(s1.contract.acceptance));
    check('retry defaults are 3 attempts, 60 s backoff, 30 min cap', s1 && JSON.stringify(s1.contract.retry) === JSON.stringify({ maxAttempts: 3, backoffMs: 60000, maxBackoffMs: 1800000 }), s1 && JSON.stringify(s1.contract.retry));
    const again = run([...base, '--story', 'S1', '--paths', 'src/tooltip/,src/index.ts']);
    check('the same story at the same base gives byte-identical output', again.stdout === r.stdout);
    const ordered = run([...base, '--story', 'S1', '--paths', 'src/index.ts,src/tooltip/']);
    check('  and a different path order is a different contract (order is part of the scope)', ordered.status === 0 && ordered.stdout !== r.stdout);
}

// ---- overrides ----------------------------------------------------------------
{
    git('remote', 'add', 'origin', 'https://example.invalid/team/repo.git');
    const r = run([...base, '--story', 'S1', '--paths', 'src/']);
    check('repo id is the origin URL when one exists', r.json && r.json.contract.repo.id === 'https://example.invalid/team/repo.git', r.json && r.json.contract.repo.id);
    check('  and the default target identifier follows it', r.json && r.json.contract.target.identifier === 'https://example.invalid/team/repo.git');
    const o = run([...base, '--story', 'S1', '--paths', 'src/', '--repo-id', 'team/repo', '--target', 'production:app.example.invalid', '--effects', 'read,write,commit', '--max-attempts', '5', '--backoff-ms', '10', '--max-backoff-ms', '20', '--mission-id', 'S1.v2', '--event-id', 'admit:S1:v2']);
    check('every override lands in the payload', o.status === 0 && o.json && o.json.contract.repo.id === 'team/repo' && o.json.contract.target.kind === 'production' && o.json.contract.target.identifier === 'app.example.invalid'
        && JSON.stringify(o.json.contract.scope.effects) === JSON.stringify(['read', 'write', 'commit']) && JSON.stringify(o.json.contract.retry) === JSON.stringify({ maxAttempts: 5, backoffMs: 10, maxBackoffMs: 20 })
        && o.json.missionId === 'S1.v2' && o.json.eventId === 'admit:S1:v2', o.stdout);
    const eq = run([...base, '--story=S1', '--paths=src/']);
    check('--flag=value form works', eq.status === 0 && eq.json && eq.json.missionId === 'S1', eq.stdout);
    const cwd = run(['--prd', prdFlat, '--story', 'S1', '--paths', 'src/'], { cwd: repo });
    check('--root defaults to the working directory', cwd.status === 0 && cwd.json && cwd.json.contract.repo.root === realRepo, cwd.stdout);
}

// ---- the five states are kept apart ------------------------------------------
{
    for (const [id, expect] of [['S2', 'done'], ['S3', 'deferred'], ['S4', 'needs-setup']]) {
        const r = run([...base, '--story', id, '--paths', 'src/']);
        check(`a ${expect} story is refused as story-not-actionable`, r.status === 1 && r.json && r.json.error.code === 'story-not-actionable', r.stdout);
        check(`  and the message quotes its passes value`, r.json && r.json.error.message.includes('passes='), r.json && r.json.error.message);
    }
    const failed = run([...base, '--story', 'S5', '--paths', 'src/']);
    check('a failed story (passes: false) is admitted: it is retryable work', failed.status === 0 && failed.json && failed.json.missionId === 'S5', failed.stdout);
    const absent = run([...base, '--story', 'S8', '--paths', 'src/']);
    check('a story without a passes key counts as pending', absent.status === 0 && absent.json && absent.json.missionId === 'S8', absent.stdout);
    const nested = run(['--prd', prdNested, '--root', repo, '--story', 'N1', '--paths', 'api/']);
    check('a story in an EARLIER sprint of a nested prd is found (storiesOf merges all sprints)', nested.status === 0 && nested.json && nested.json.contract.acceptance[0].id === 'N1', nested.stdout);
    const nestedDone = run(['--prd', prdNested, '--root', repo, '--story', 'N2', '--paths', 'api/']);
    check('  and the newest sprint being done does not make it admissible', nestedDone.status === 1 && nestedDone.json && nestedDone.json.error.code === 'story-not-actionable', nestedDone.stdout);
}

// ---- every malformed input is a named refusal ----------------------------------
{
    const cases = [
        ['story-missing', [...base, '--story', 'S99', '--paths', 'src/']],
        ['no-acceptance-criterion', [...base, '--story', 'S6', '--paths', 'src/']],
        ['acceptance-too-long', [...base, '--story', 'S7', '--paths', 'src/']],
        ['story-id-invalid', [...base, '--story', '../S1', '--paths', 'src/']],
        ['invalid-paths', [...base, '--story', 'S1', '--paths', '../escape']],
        ['invalid-paths', [...base, '--story', 'S1', '--paths', '/etc/passwd']],
        ['invalid-paths', [...base, '--story', 'S1', '--paths', 'src/,src/']],
        ['invalid-paths', [...base, '--story', 'S1', '--paths', ' , ']],
        ['invalid-effects', [...base, '--story', 'S1', '--paths', 'src/', '--effects', 'read,anything']],
        ['invalid-target', [...base, '--story', 'S1', '--paths', 'src/', '--target', 'bogus:x']],
        ['invalid-target', [...base, '--story', 'S1', '--paths', 'src/', '--target', 'local']],
        ['invalid-retry', [...base, '--story', 'S1', '--paths', 'src/', '--max-attempts', '0']],
        ['invalid-retry', [...base, '--story', 'S1', '--paths', 'src/', '--backoff-ms', '100', '--max-backoff-ms', '50']],
        ['invalid-mission-id', [...base, '--story', 'S1', '--paths', 'src/', '--mission-id', 'has space']],
        ['prd-unreadable', ['--prd', path.join(ROOT, 'absent.json'), '--root', repo, '--story', 'S1', '--paths', 'src/']],
        ['repo-unverified', ['--prd', prdFlat, '--root', ROOT, '--story', 'S1', '--paths', 'src/']],
    ];
    for (const [code, args] of cases) {
        const r = run(args);
        check(`${code}: ${args.slice(4).join(' ')}`, r.status === 1 && r.json && r.json.ok === false && r.json.error.code === code, r.stdout + r.stderr);
        check('  and nothing but the refusal reached stdout', r.stdout.trim().split('\n').length === 1);
    }
    fs.writeFileSync(path.join(ROOT, 'broken.json'), '{not json');
    const broken = run(['--prd', path.join(ROOT, 'broken.json'), '--root', repo, '--story', 'S1', '--paths', 'src/']);
    check('malformed prd json is prd-unreadable', broken.status === 1 && broken.json && broken.json.error.code === 'prd-unreadable', broken.stdout);
}

// ---- compare-before-write, against the real store ------------------------------
{
    const posix = typeof process.getuid === 'function';
    let sqlite = false; try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch { /* absent */ }
    if (!(posix && sqlite)) {
        const why = !posix ? 'POSIX ownership checks (win32)' : 'node:sqlite';
        const r = storeCli('init', path.join(ROOT, 'store'), {});
        check(`store integration not run here: host lacks ${why}; the store refuses explicitly instead`, r.status === 1 && r.json && r.json.error && r.json.error.code === 'runtime-unavailable', r.stdout);
        console.log(`mission-contract: store integration (4 cases) skipped on this host — lacks ${why}`);
    } else {
        const store = path.join(ROOT, 'store');
        const init = storeCli('init', store, {});
        check('store init', init.status === 0 && init.json && init.json.ok === true, init.stdout + init.stderr);
        const payload = run([...base, '--story', 'S1', '--paths', 'src/tooltip/']).json;
        const admit = storeCli('admit', store, payload);
        check('the payload is accepted by mission-store.js admit as-is', admit.status === 0 && admit.json && admit.json.ok === true && admit.json.value.state === 'ready', admit.stdout + admit.stderr);
        const status = storeCli('status', store, { missionId: 'S1' });
        check('  and status returns the same contract', status.json && canon(status.json.value.mission.contract) === canon(payload.contract), status.stdout);
        const replay = storeCli('admit', store, run([...base, '--story', 'S1', '--paths', 'src/tooltip/']).json);
        check('re-running the builder and admitting again is idempotent (same eventId, same bytes)', replay.status === 0 && replay.json && canon(replay.json.value) === canon(admit.json.value), replay.stdout);
        // The criterion changes under the same story id.
        const edited = JSON.parse(fs.readFileSync(prdFlat, 'utf8'));
        edited.stories.S1.notes = 'A tooltip near the viewport edge is clipped, which is fine.';
        fs.writeFileSync(prdFlat, JSON.stringify(edited, null, 2));
        const changed = run([...base, '--story', 'S1', '--paths', 'src/tooltip/']).json;
        check('a changed criterion is a different contract', changed && canon(changed.contract) !== canon(payload.contract));
        const conflict = storeCli('admit', store, changed);
        check('  which the store refuses under the original eventId (event-conflict): compare-before-write', conflict.status === 1 && conflict.json && conflict.json.error.code === 'event-conflict', conflict.stdout);
        const after = storeCli('status', store, { missionId: 'S1' });
        check('  and the recorded contract is untouched', after.json && canon(after.json.value.mission.contract) === canon(payload.contract));
        const renamedEvent = storeCli('admit', store, run([...base, '--story', 'S1', '--paths', 'src/tooltip/', '--event-id', 'admit:S1:v2']).json);
        check('a new eventId with the same missionId is still refused (mission-exists), so the old record cannot be overwritten', renamedEvent.status === 1 && renamedEvent.json && renamedEvent.json.error.code === 'mission-exists', renamedEvent.stdout);
        const v2 = storeCli('admit', store, run([...base, '--story', 'S1', '--paths', 'src/tooltip/', '--mission-id', 'S1.v2', '--event-id', 'admit:S1:v2']).json);
        check('a new missionId admits the revised criterion as a new mission beside the old record', v2.status === 0 && v2.json && v2.json.ok === true, v2.stdout);
    }
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* leave it */ }

const total = passed + failures.length;
if (failures.length) {
    console.error(`mission-contract: ${passed}/${total} passed, ${failures.length} FAILED\n`);
    for (const f of failures) console.error('  x ' + f);
    process.exitCode = 1;
} else {
    console.log(`mission-contract: ${passed}/${total} passed — deterministic payloads, five prd states kept apart, named refusals, and compare-before-write against the store`);
}
