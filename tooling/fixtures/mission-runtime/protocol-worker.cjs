'use strict';
// Fixture worker for mission-dispatch.js: speaks the IPC protocol documented in that
// script, registers itself with the store, writes exactly one owned artifact inside
// the contract's scope, enqueues its result, reports completion. The dispatcher
// forks workers with a minimal environment on purpose, so the mode comes from a
// file beside the store: '<store>.mode.<missionId>' first, then '<store>.mode'
// (env MISSION_WORKER_MODE as a fallback), so one store can host missions that behave differently:
//   normal          register, write owned.js, enqueue, complete, exit 0
//   chdir           report a cwd outside the contract root (the dispatcher must refuse)
//   refuse          send refused and exit 1 without registering
//   hold            register, then wait for {kind:'release'} before finishing
//   die-after-write register, write the artifact, then exit without enqueuing or completing
//   blocked         register, complete with hookStatus 'blocked', no artifact
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process'); const { randomUUID, createHash } = require('node:crypto');
const { execute, digest } = require('../../../plugins/autodev-core/scripts/mission-store.js');
const send = (m) => new Promise((resolve) => { if (process.connected) process.send(m, () => resolve()); else resolve(); });
const release = () => new Promise((resolve) => process.once('message', (m) => resolve(m)));
process.once('message', async (m) => {
    try {
        if (!m || m.kind !== 'assignment') throw Object.assign(new Error('expected an assignment'), { publicCode: 'protocol' });
        const { store, fence, nonce, contract } = m;
        let mode = process.env.MISSION_WORKER_MODE || 'normal';
        for (const f of [store + '.mode', store + '.mode.' + fence.missionId]) { try { mode = fs.readFileSync(f, 'utf8').trim() || mode; } catch { /* no mode file */ } }
        const command = (c, p = {}) => execute(c, store, { ...fence, eventId: randomUUID(), ...p });
        if (mode === 'refuse') { await send({ kind: 'refused', code: 'fixture-refuses' }); process.exitCode = 1; if (process.connected) process.disconnect(); return; }
        const identity = { host: os.hostname(), pid: process.pid, nonce };
        command('register-executor', { identity });
        const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        let origin = ''; try { origin = git('remote', 'get-url', 'origin'); } catch { origin = ''; }
        const cwd = mode === 'chdir' ? os.tmpdir() : process.cwd();
        await send({ kind: 'registered', identity, cwd, head: git('rev-parse', 'HEAD'), origin });
        if (mode === 'chdir') { await release(); return; }
        if (mode === 'hold') await release();
        if (mode === 'blocked') { await send({ kind: 'completion', hookStatus: 'blocked', nativeStatus: 'completed' }); if (process.connected) process.disconnect(); return; }
        const target = contract.scope.paths[0]; if (!target || target.endsWith('/')) throw Object.assign(new Error('fixture needs a file path in scope'), { publicCode: 'fixture-scope' });
        const content = 'module.exports = () => ({ ok: true, source: "protocol-worker" });\n';
        const temp = path.join(store, 'artifact-' + randomUUID() + '.tmp'); fs.writeFileSync(temp, content, { mode: 0o600 }); fs.renameSync(temp, path.join(process.cwd(), target));
        if (mode === 'die-after-write') { process.exitCode = 0; if (process.connected) process.disconnect(); return; }
        const result = { resultId: 'result-' + fence.attemptId, contractHash: execute('status', store, { missionId: fence.missionId }).mission.contractHash, repoId: contract.repo.id, baseSha: contract.repo.baseSha, candidateSha: contract.repo.baseSha, acceptanceIds: contract.acceptance.map((a) => a.id), artifacts: [{ path: target, sha256: digest(content) }] };
        command('enqueue-result', { messageId: 'message-' + fence.attemptId, result, artifactBundle: [{ path: target, content }] });
        await send({ kind: 'completion', hookStatus: 'completed', nativeStatus: 'completed' });
        if (process.connected) process.disconnect();
    } catch (e) { await send({ kind: 'refused', code: e.publicCode || e.message }); process.exitCode = 1; if (process.connected) process.disconnect(); }
});
