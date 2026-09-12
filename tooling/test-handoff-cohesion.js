#!/usr/bin/env node
'use strict';
// Independent, tests-first acceptance for requirements -> plan -> dispatch handoffs.
// Real CLI processes and a real protocol fixture worker; no model execution claim.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
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
function tick(f, adapter = 'local-node', wait = '10000', extra = []) { return cli('mission-supervisor.js', ['tick', '--prd', f.prd, '--root', f.repo, '--store', f.store, '--owner', 'brain', '--adapter', adapter, '--worker', worker, '--wait-ms', wait, ...extra]); }
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
    for (const badId of [null, 42, true]) {
        const malformed = fixture();
        malformed.doc.stories.A.acceptance = [{ id: badId, description: 'Only the owner may read the stored record.' }]; malformed.write();
        const r = build(malformed);
        check('canonical criterion id must be text: ' + JSON.stringify(badId), r.status === 1 && r.json && r.json.error.code === 'acceptance-invalid', r);
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

    const carried = { sprints: [
        { id: 1, stories: { 'S1-001': story('S1-001') } },
        { id: 2, stories: { 'S1-001': { ...story('S1-001'), passes: true }, 'S2-001': { ...story('S2-001'), blockedBy: ['S1-001'] } } },
    ] };
    const carriedFile = path.join(ROOT, 'carried.json'); fs.writeFileSync(carriedFile, JSON.stringify(carried));
    const carriedExisting = cli('check-spec-output.js', ['--existing', carriedFile]);
    check('existing carried prerequisite uses later sprint completed record', carriedExisting.status === 0, carriedExisting);
    const carriedNew = cli('check-spec-output.js', [carriedFile]);
    check('new-plan duplicate control still refuses carried IDs', carriedNew.status === 1 && /duplicate id/.test(carriedNew.stderr), carriedNew);

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

    fs.unlinkSync(path.join(revisionFixture.repo, refs[0][0])); const deleted = revisions();
    check('deleted scoped spec remains stale and affects transitive dependents', deleted.status === 1 && deleted.json && deleted.json.stale.some(r => r.id === 'A' && r.actualRevision === null && r.reason === 'spec-unreadable') && JSON.stringify(deleted.json.affected) === JSON.stringify(['A', 'B', 'C']) && JSON.stringify(deleted.json.unchanged) === JSON.stringify(['D']), deleted);

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
        const retried = fixture(); cli('mission-store.js', ['init', '--store', retried.store], {});
        const retryFlags = ['--backoff-ms', '1', '--max-backoff-ms', '5'];
        fs.writeFileSync(retried.store + '.mode', 'refuse'); const refusal = tick(retried, 'local-node', '10000', retryFlags);
        check('retry control reaches retry-wait with exactly one refused attempt', refusal.value && state(retried).mission.state === 'retry-wait' && state(retried).mission.attemptCount === 1, refusal);
        retried.doc.stories.A.passes = 'needs-setup'; retried.write(); fs.writeFileSync(retried.store + '.mode', 'normal');
        const retryBlocked = tick(retried, 'local-node', '10000', retryFlags);
        check('eligible retry rechecks readiness before a second attempt', state(retried).launches.length === 1 && state(retried).mission.attemptCount === 1 && !fs.existsSync(path.join(retried.repo, 'owned.js')) && retryBlocked.value.missions.some(m => m.id === 'A' && m.action === 'not-ready'), retryBlocked);

        const sourced = fixture(), spec = 'Only the owner may view these records.\n';
        fs.writeFileSync(path.join(sourced.repo, 'SPEC.md'), spec); sourced.doc.stories.A.specRefs = [{ path: 'SPEC.md', revision: hash(spec) }]; sourced.write();
        const wt = path.join(sourced.dir, 'worker'); execFileSync('git', ['-C', sourced.repo, 'worktree', 'add', '--detach', '-q', wt, 'HEAD'], { stdio: 'pipe' });
        const sourceArgs = ['--prd', sourced.prd, '--story', 'A', '--paths', 'owned.js', '--root', wt];
        const noSource = cli('mission-contract.js', sourceArgs);
        const source = cli('mission-contract.js', [...sourceArgs, '--source-root', sourced.repo]);
        check('detached worker contract reads explicitly scoped uncommitted spec from planning worktree', noSource.status === 1 && source.status === 0 && source.json.contract.repo.root === fs.realpathSync.native(wt) && source.json.contract.specRefs[0].content === spec, { noSource, source });
        const foreignSource = fixture(); fs.writeFileSync(path.join(foreignSource.repo, 'SPEC.md'), spec);
        const wrongSource = cli('mission-contract.js', [...sourceArgs, '--source-root', foreignSource.repo]);
        check('source-root from a different repository is refused', wrongSource.status === 1 && wrongSource.json.error.code === 'repo-unverified', wrongSource);

        const racing = fixture(); cli('mission-store.js', ['init', '--store', racing.store], {});
        racing.doc.stories.B = { id: 'B', title: 'Read the second owned record', passes: null, notes: 'The second module returns the current account record.', paths: ['second.js'] }; racing.write();
        fs.writeFileSync(racing.store + '.mode.A', 'hold');
        const marker = path.join(racing.dir, 'changed'), watcher = path.join(racing.dir, 'watcher.cjs');
        fs.writeFileSync(watcher, `const fs=require('node:fs');const {execute}=require(${JSON.stringify(path.join(scripts, 'mission-store.js'))});const stop=Date.now()+20000;const t=setInterval(()=>{try{const s=execute('status',${JSON.stringify(racing.store)},{missionId:'A'});if(s.launches.some(l=>l.state==='registered')){const p=JSON.parse(fs.readFileSync(${JSON.stringify(racing.prd)},'utf8'));p.stories.B.passes='needs-setup';fs.writeFileSync(${JSON.stringify(racing.prd)},JSON.stringify(p));fs.writeFileSync(${JSON.stringify(marker)},'changed');clearInterval(t);}}catch{}if(Date.now()>stop)clearInterval(t);},20);`);
        const writer = spawn(process.execPath, [watcher], { stdio: 'ignore' }); workerPids.add(writer.pid);
        const raceResult = tick(racing, 'local-node', '1500', ['--max-dispatch', '2', '--worktrees', path.join(racing.dir, 'wt')]);
        const raceState = state(racing), raceLaunch = raceState && raceState.launches.find(l => l.state === 'registered');
        if (raceLaunch) workerPids.add(JSON.parse(raceLaunch.identity_json).pid);
        const secondState = cli('mission-store.js', ['status', '--store', racing.store], { missionId: 'B' });
        check('same-tick control changed the second candidate while first worker was awaited', fs.existsSync(marker) && raceLaunch, raceResult);
        check('second candidate rereads current readiness after awaiting first worker', secondState.status === 1 && secondState.json.error.code === 'mission-missing' && raceResult.value.missions.some(m => m.id === 'B' && m.action === 'not-ready') && !fs.existsSync(path.join(racing.dir, 'wt', 'B', 'second.js')), { raceResult, secondState });

        const tamper = fixture(); cli('mission-store.js', ['init', '--store', tamper.store], {});
        const validPayload = build(tamper).json;
        validPayload.contract.specRefs = [{ path: 'SPEC.md', revision: hash('Original requirement.\n'), content: 'Original requirement.\n' }];
        const original = cli('mission-store.js', ['admit', '--store', tamper.store], validPayload);
        check('store accepts independently hashed spec snapshot control', original.status === 0 && original.json.ok, original);
        validPayload.eventId = 'tamper'; validPayload.missionId = 'tampered'; validPayload.contract.specRefs[0].content = 'A different requirement.\n';
        const tampered = cli('mission-store.js', ['admit', '--store', tamper.store], validPayload);
        check('store refuses tampered frozen content under original revision', tampered.status === 1 && tampered.json && tampered.json.error.code === 'invalid-contract', tampered);

        const x = fixture(); cli('mission-store.js', ['init', '--store', x.store], {});
        fs.writeFileSync(x.store + '.mode', 'hold'); const running = tick(x, 'local-node', '1500'); let before = state(x);
        const registered = before && before.launches.find(l => l.state === 'registered');
        if (registered) workerPids.add(JSON.parse(registered.identity_json).pid);
        check('live control registers exactly one held worker', running.status === 0 && registered && before.launches.length === 1, running);
        x.doc.stories.A.passes = 'needs-setup'; x.write(); const reconciled = tick(x); const after = state(x);
        check('newly blocked live attempt is reconciled, never duplicated or released', after && after.launches.length === 1 && after.mission.attemptCount === 1 && after.mission.state === 'claimed' && reconciled.value && reconciled.value.missions.some(m => m.id === 'A' && ['worker-live', 'worker-unknown', 'backoff-active', 'reconciliation-exhausted'].includes(m.action)), reconciled);
        delete x.doc.stories.A; x.write(); const removed = tick(x); const afterRemoval = state(x);
        check('removed story live attempt remains visible and reconciled without duplicate', afterRemoval && afterRemoval.launches.length === 1 && afterRemoval.mission.state === 'claimed' && removed.value && removed.value.missions.some(m => m.id === 'A' && m.action.startsWith('worker-') && m.reservationHeld === true), removed);
        const foreign = fixture(); foreign.store = x.store;
        const beforeForeign = JSON.stringify(state(x)); const rejected = tick(foreign);
        check('foreign repository story-id collision never settles original mission', rejected.value && rejected.value.missions.some(m => m.id === 'A' && m.code === 'repository-conflict') && JSON.stringify(state(x)) === beforeForeign, rejected);
    }
} finally {
    for (const pid of workerPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(ROOT, { recursive: true, force: true });
}
console.log(`handoff-cohesion: ${passed}/${passed + failures.length} assertions passed`);
for (const failure of failures) console.error('FAIL ' + failure);
if (failures.length) process.exitCode = 1;
