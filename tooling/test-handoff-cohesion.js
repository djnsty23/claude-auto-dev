#!/usr/bin/env node
'use strict';
// Independent, tests-first acceptance for requirements -> plan -> dispatch handoffs.
// Real CLI processes and a real protocol fixture worker; no model execution claim.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const ROOT = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'handoff-cohesion-'));
const scripts = path.resolve(__dirname, '../plugins/autodev-core/scripts');
const worker = path.resolve(__dirname, 'fixtures/mission-runtime/protocol-worker.cjs');
let passed = 0; const failures = []; const workerPids = new Set();
function check(name, condition, detail) { if (condition) passed++; else failures.push(name + '\n    ' + JSON.stringify(detail).slice(0, 800)); }
function cli(file, args, input) {
    const r = spawnSync(process.execPath, [path.join(scripts, file), ...args], { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 40000 });
    let json; try { json = JSON.parse(r.stdout); } catch { json = null; }
    return { status: r.status, json, value: json && json.value, stdout: r.stdout, stderr: r.stderr };
}
let serial = 0;
function fixture() {
    const dir = path.join(ROOT, String(++serial)), repo = path.join(dir, 'repo'); fs.mkdirSync(repo, { recursive: true });
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=' + path.join(ROOT, 'no-hooks'), '-c', 'commit.gpgSign=false', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git('add', 'README.md');
    const message = path.join(dir, 'commit.txt'); fs.writeFileSync(message, 'test fixture base\n');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-F', message);
    const prd = path.join(repo, 'prd.json'), store = path.join(dir, 'store');
    const doc = { stories: { A: { id: 'A', title: 'Return the owned record', passes: null, notes: 'The owned module exports a function returning ok.', paths: ['owned.js'] } } };
    const write = () => fs.writeFileSync(prd, JSON.stringify(doc)); write();
    return { dir, repo, prd, store, doc, write };
}
function build(f) { return cli('mission-contract.js', ['--prd', f.prd, '--story', 'A', '--paths', 'owned.js', '--root', f.repo]); }
function tick(f, adapter = 'local-node', wait = '10000') { return cli('mission-supervisor.js', ['tick', '--prd', f.prd, '--root', f.repo, '--store', f.store, '--owner', 'brain', '--adapter', adapter, '--worker', worker, '--wait-ms', wait]); }
function state(f) { return cli('mission-store.js', ['status', '--store', f.store], { missionId: 'A' }).value; }
try {
    const f = fixture();
    const legacy = build(f);
    check('legacy notes-only stories still produce their criterion', legacy.status === 0 && legacy.json.contract.acceptance.some(a => a.description === f.doc.stories.A.notes), legacy);
    f.doc.stories.A.acceptance = ['A different account cannot read these records.'];
    f.doc.stories.A.verify = ['auth', 'test']; f.write();
    const baseline = build(f);
    check('acceptance array criterion survives alongside diagnostic notes', baseline.status === 0 && JSON.stringify(baseline.json.contract).includes(f.doc.stories.A.acceptance[0]), baseline);
    check('verification obligations survive contract serialization', baseline.status === 0 && JSON.stringify(baseline.json.contract).includes('"auth"') && JSON.stringify(baseline.json.contract).includes('"test"'), baseline);
    f.doc.stories.A.acceptance[0] = 'A different account cannot read or overwrite these records.'; f.write();
    const acceptanceEdit = build(f);
    check('acceptance edit at the same git base changes the contract', acceptanceEdit.status === 0 && JSON.stringify(acceptanceEdit.json.contract) !== JSON.stringify(baseline.json.contract), acceptanceEdit);
    f.doc.stories.A.verify.push('api'); f.write(); const verificationEdit = build(f);
    check('verification edit changes the contract', verificationEdit.status === 0 && JSON.stringify(verificationEdit.json.contract) !== JSON.stringify(acceptanceEdit.json.contract), verificationEdit);
    delete f.doc.stories.A.notes; f.write(); const arrayOnly = build(f);
    check('documented acceptance-only story does not require notes', arrayOnly.status === 0, arrayOnly);

    // Explicit scoped revision identity; hashes are independently computed from raw bytes.
    const hash = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
    const specText = 'Only the owner may read the record.\n';
    fs.mkdirSync(path.join(f.repo, 'specs')); fs.writeFileSync(path.join(f.repo, 'specs/record.md'), specText);
    f.doc.stories.A.acceptance = [{ id: 'owner-only', description: 'Only the owner may read the record.' }];
    f.doc.stories.A.verify = [{ id: 'deny-other', description: 'Cross-account request returns 403.' }];
    f.doc.stories.A.specRefs = [{ path: 'specs/record.md', revision: hash(specText) }]; f.write();
    const bound = build(f);
    check('explicit acceptance IDs and descriptions survive', bound.status === 0 && bound.json.contract.acceptance.some(a => a.id === 'owner-only' && a.description === 'Only the owner may read the record.'), bound);
    check('explicit verification IDs and descriptions survive', bound.status === 0 && Array.isArray(bound.json.contract.verification) && bound.json.contract.verification.some(a => a.id === 'deny-other' && a.description === 'Cross-account request returns 403.'), bound);
    check('spec snapshot binds path, exact raw revision, and original content', bound.status === 0 && Array.isArray(bound.json.contract.specRefs) && bound.json.contract.specRefs.some(r => r.path === 'specs/record.md' && r.revision === hash(specText) && r.content === specText), bound);
    fs.writeFileSync(path.join(f.repo, 'specs/unrelated.md'), 'An unrelated task changed.\n');
    const unrelated = build(f);
    check('unrelated unreferenced spec edit leaves contract unchanged', bound.status === 0 && unrelated.status === 0 && JSON.stringify(bound.json.contract) === JSON.stringify(unrelated.json.contract), unrelated);
    fs.writeFileSync(path.join(f.repo, 'specs/record.md'), 'Suspended owners are denied too.\n');
    const mismatch = build(f);
    check('changed scoped spec refuses stale declared revision', mismatch.status === 1 && mismatch.json.error.code === 'spec-revision-mismatch', mismatch);
    fs.writeFileSync(path.join(f.repo, 'specs/record.md'), specText); delete f.doc.stories.A.specRefs[0].revision; f.write();
    const missing = build(f);
    check('explicit spec reference without revision refuses admission', missing.status === 1 && missing.json.error.code === 'spec-revision-mismatch', missing);

    const story = id => ({ id, title: 'Log a habit from the home screen', priority: 1, passes: null, type: 'feature', notes: 'Tapping a habit inserts one check-in and increments its streak.' });
    const plans = [
        ['ordinary ready control', { 'S1-001': story('S1-001') }, true],
        ['valid pending prerequisite control', { 'S1-001': story('S1-001'), 'S1-002': { ...story('S1-002'), blockedBy: ['S1-001'] } }, true],
        ['dangling prerequisite', { 'S1-001': { ...story('S1-001'), blockedBy: ['missing'] } }, false],
        ['two-story dependency cycle', { 'S1-001': { ...story('S1-001'), blockedBy: ['S1-002'] }, 'S1-002': { ...story('S1-002'), blockedBy: ['S1-001'] } }, false],
        ['string blockedBy', { 'S1-001': { ...story('S1-001'), blockedBy: 'S1-002' } }, false],
        ['non-string dependency member', { 'S1-001': { ...story('S1-001'), blockedBy: [42] } }, false],
    ];
    for (const [name, stories, valid] of plans) {
        const file = path.join(ROOT, 'plan.json'); fs.writeFileSync(file, JSON.stringify({ stories }));
        const r = cli('check-spec-output.js', [file]);
        check('plan: ' + name, valid ? r.status === 0 : r.status === 1 && /depend|blockedBy|cycle|missing/i.test(r.stdout + r.stderr), r);
    }
    // Existing plans retain all five passes states while graph validation remains active.
    const existing = { stories: Object.fromEntries([null, true, false, 'deferred', 'needs-setup'].map((passes, n) => {
        const id = 'S1-00' + (n + 1); return [id, { ...story(id), passes }];
    })) };
    const existingFile = path.join(ROOT, 'existing.json'); fs.writeFileSync(existingFile, JSON.stringify(existing));
    const existingResult = cli('check-spec-output.js', ['--existing', existingFile]);
    check('existing-plan mode accepts all five valid passes states', existingResult.status === 0, existingResult);
    existing.stories['S1-001'].blockedBy = ['S9-999']; fs.writeFileSync(existingFile, JSON.stringify(existing));
    const existingBad = cli('check-spec-output.js', ['--existing', existingFile]);
    check('existing-plan mode still rejects dangling dependencies', existingBad.status === 1 && /depend|missing|blockedBy/i.test(existingBad.stdout + existingBad.stderr), existingBad);

    const revisionFixture = fixture();
    fs.mkdirSync(path.join(revisionFixture.repo, 'specs'));
    const refs = [['specs/a.md', 'First requirement.\n'], ['specs/b.md', 'Unrelated requirement.\n']];
    for (const [name, content] of refs) fs.writeFileSync(path.join(revisionFixture.repo, name), content);
    revisionFixture.doc.stories = {
        A: { ...story('A'), specRefs: [{ path: refs[0][0], revision: hash(refs[0][1]) }] },
        B: { ...story('B'), blockedBy: ['A'] },
        C: { ...story('C'), blockedBy: ['B'] },
        D: { ...story('D'), specRefs: [{ path: refs[1][0], revision: hash(refs[1][1]) }] },
    }; revisionFixture.write();
    const revisions = () => cli('prd-requirements.js', ['revisions', '--prd', revisionFixture.prd, '--root', revisionFixture.repo]);
    const clean = revisions();
    check('revision report clean control covers all four stories', clean.status === 0 && clean.json && clean.json.stories === 4 && clean.json.stale.length === 0 && clean.json.affected.length === 0, clean);
    const editedSpec = 'First requirement now denies suspended owners.\n'; fs.writeFileSync(path.join(revisionFixture.repo, refs[0][0]), editedSpec);
    const prdBytes = fs.readFileSync(revisionFixture.prd, 'utf8'), changed = revisions();
    check('revision report identifies direct stale reference with both exact hashes', changed.status === 1 && changed.json && changed.json.stories === 4 && changed.json.stale.some(r => r.id === 'A' && r.path === refs[0][0] && r.expectedRevision === hash(refs[0][1]) && r.actualRevision === hash(editedSpec)), changed);
    check('revision impact is direct story plus transitive dependents, excluding unrelated story', changed.json && JSON.stringify([...changed.json.affected].sort()) === JSON.stringify(['A', 'B', 'C']) && JSON.stringify(changed.json.unchanged) === JSON.stringify(['D']), changed);
    check('revision report never rewrites acceptance or declares a new revision', fs.readFileSync(revisionFixture.prd, 'utf8') === prdBytes, changed);

    let sqlite = false; try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch { /* host unavailable */ }
    if (typeof process.getuid !== 'function' || !sqlite) {
        const r = cli('mission-store.js', ['init', '--store', path.join(ROOT, 'unavailable')], {});
        check('unsupported host refuses runtime explicitly', r.status === 1 && r.json && r.json.error.code === 'runtime-unavailable', r);
        console.log('handoff-cohesion: runtime transition cases not run; host lacks POSIX ownership or node:sqlite');
    } else {
        for (const variant of ['ready', 'needs-setup', 'unmet-dependency', 'scope-edit', 'acceptance-edit', 'verification-edit']) {
            const x = fixture(); cli('mission-store.js', ['init', '--store', x.store], {});
            const admitted = tick(x, 'unsupported'); const before = state(x);
            check(variant + ': setup admitted without a launch', admitted.status === 0 && before && before.mission.state === 'ready' && before.launches.length === 0, admitted);
            if (variant === 'needs-setup') x.doc.stories.A.passes = 'needs-setup';
            if (variant === 'unmet-dependency') { x.doc.stories.A.blockedBy = ['B']; x.doc.stories.B = { id: 'B', passes: 'needs-setup', notes: 'Needs an operator key.', paths: ['second.js'] }; }
            if (variant === 'scope-edit') x.doc.stories.A.paths = ['different.js'];
            if (variant === 'acceptance-edit') x.doc.stories.A.acceptance = ['Unauthenticated requests cannot read the owned record.'];
            if (variant === 'verification-edit') x.doc.stories.A.verify = ['auth'];
            x.write(); const prdBefore = fs.readFileSync(x.prd, 'utf8'); const result = tick(x); const after = state(x);
            check(variant + ': tick returns a report', result.status === 0 && result.value && Array.isArray(result.value.missions), result);
            if (variant === 'ready') check('ready control launches and writes its actual artifact', after.launches.length === 1 && fs.existsSync(path.join(x.repo, 'owned.js')), result);
            else check(variant + ': no worker starts against newly blocked or stale requirements', after.launches.length === 0 && after.mission.attemptCount === 0 && !fs.existsSync(path.join(x.repo, 'owned.js')) && !fs.existsSync(path.join(x.repo, 'different.js')), { result, state: after });
            check(variant + ': PRD stays byte-identical', prdBefore === fs.readFileSync(x.prd, 'utf8'), result);
        }
        const x = fixture(); cli('mission-store.js', ['init', '--store', x.store], {});
        fs.writeFileSync(x.store + '.mode', 'hold'); const running = tick(x, 'local-node', '1500'); let before = state(x);
        const registered = before && before.launches.find(l => l.state === 'registered');
        if (registered) workerPids.add(JSON.parse(registered.identity_json).pid);
        check('live control registers exactly one held worker', running.status === 0 && registered && before.launches.length === 1, running);
        x.doc.stories.A.passes = 'needs-setup'; x.write(); const reconciled = tick(x); const after = state(x);
        check('newly blocked live attempt is reconciled, never duplicated or released', after && after.launches.length === 1 && after.mission.attemptCount === 1 && after.mission.state === 'claimed' && reconciled.value && reconciled.value.missions.some(m => m.id === 'A' && ['worker-live', 'worker-unknown', 'backoff-active', 'reconciliation-exhausted'].includes(m.action)), reconciled);
    }
} finally {
    for (const pid of workerPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(ROOT, { recursive: true, force: true });
}
console.log(`handoff-cohesion: ${passed}/${passed + failures.length} assertions passed`);
for (const failure of failures) console.error('FAIL ' + failure);
if (failures.length) process.exitCode = 1;
