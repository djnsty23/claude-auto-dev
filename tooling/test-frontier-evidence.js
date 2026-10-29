#!/usr/bin/env node
'use strict';
// Real subprocesses, synthetic outcomes, isolated data. Never launches a model.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const SCRIPT = path.resolve(__dirname, '../plugins/autodev-core/scripts/frontier-evidence.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-evidence-'));
const tasks = path.join(root, 'tasks'), data = path.join(root, 'data');
let count = 0, failures = 0;
function check(name, ok, detail) { count++; if (!ok) failures++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${!ok ? ': ' + JSON.stringify(detail) : ''}`); }
const write = (f, value) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, value); };
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const invoke = (args = [], dir = data) => spawnSync(process.execPath, [SCRIPT, ...args, '--data', dir], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'home') } });
const ledger = path.join(data, 'runs.jsonl');
const save = (r) => write(ledger, r.map((v) => JSON.stringify(v)).join('\n') + '\n');
function observe() {
    const r = invoke(['observe']); check('observer exits cleanly', r.status === 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : JSON.parse(fs.readFileSync(path.join(data, 'routing-comparisons.jsonl'), 'utf8').trim().split('\n').at(-1));
}
try {
    const empty = invoke(['observe']);
    check('no split is silent and creates no data', empty.status === 0 && empty.stdout === '' && empty.stderr === '' && !fs.existsSync(data), empty);
    for (let n = 1; n <= 12; n++) write(path.join(tasks, `T${n}.json`), JSON.stringify({ id: `T${n}`, lane: n === 7 ? 'locate' : 'fix', brief: `T${n}.md` }));
    for (let n = 1; n <= 12; n++) write(path.join(tasks, `T${n}.md`), `Task ${n}: repair the fixture without changing the expected output.\n`);
    let r = invoke(['split', '--tasks-dir', tasks]);
    check('split CLI succeeds', r.status === 0, r.stderr);
    const frozen = json(path.join(data, 'routing-split.json'));
    check('all twelve ids carry an independently verified seeded hash', frozen.tasks.length === 12 && frozen.tasks.every((t) => {
        const digest = crypto.createHash('sha256').update(`frontier-routing-v1:${t.id}`).digest('hex');
        return t.idHash === digest && t.split === (parseInt(digest.slice(0, 8), 16) % 2 ? 'held-out' : 'training');
    }));
    r = invoke(['split', '--tasks-dir', tasks]);
    check('split is immutable on rerun', r.status === 0 && r.stdout.trim() === JSON.stringify(frozen));
    const other = invoke(['split', '--tasks-dir', tasks], path.join(root, 'other'));
    check('fresh roots get the identical split id', other.status === 0 && JSON.parse(other.stdout).splitId === frozen.splitId);
    const held = frozen.tasks.filter((t) => t.split === 'held-out');
    check('fixed population contains both splits', held.length > 0 && held.length < 12, held.length);
    const startedAt = new Date(Date.parse(frozen.createdAt) + 1000).toISOString();
    const finishedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
    const input = held.flatMap((t) => ['baseline', 'routed'].map((arm) => {
        const variant = arm === 'baseline' ? 'V0' : t.lane === 'locate' ? 'H1' : 'V1';
        return { run: `${t.id}-${arm}`, task: t.id, splitId: frozen.splitId, split: 'held-out', taskIdHash: t.idHash,
            heldOutHash: t.contentHash, sealed: true,
            seal: { checkedAt: startedAt, contentMatches: true, currentHash: t.contentHash, visibleToLearning: false, hits: [], errors: [] },
            routingArm: arm, route: variant, variant, repeat: 1, taskHash: t.id + '-content', account: 'fixture',
            startedAt, finishedAt, exit: 0, verdict: 'pass', pass: true, leak: { suspect: false },
            fingerprint: { model: variant, requestedModel: variant, snapshot: 'snapshot', harnessCommit: 'revision', pinHash: 'plugins' } };
    }));
    save(input);
    const clean = observe();
    check('matched held-out comparison passes the upfront margin', clean.complete && clean.nonInferior && clean.delta === 0 && clean.margin === 0.05 && clean.paired === held.length, clean);
    r = invoke(['observe']);
    check('unchanged observer is silent and does not append', r.status === 0 && r.stdout === '' && fs.readFileSync(path.join(data, 'routing-comparisons.jsonl'), 'utf8').trim().split('\n').length === 1);
    save(input.map((v) => v.routingArm === 'routed' ? { ...v, pass: false, verdict: 'fail' } : v));
    const inferior = observe();
    check('inferior routed arm fails non-inferiority', inferior.complete && !inferior.nonInferior && inferior.delta === -1, inferior);
    save(input.slice(1));
    check('missing baseline cannot yield a comparison', !observe().complete);
    save([...input, input[0]]);
    check('duplicate attempts cannot cherry-pick a pass', !observe().complete);
    save(input.map((v, i) => i === 0 ? { ...v, split: 'training' } : v));
    check('training rows do not fill held-out cells', !observe().complete);
    save(input.map((v, i) => i === 0 ? { ...v, startedAt: '2000-01-01T00:00:00Z' } : v));
    check('pre-split outcomes are inadmissible', !observe().complete);
    save(input.map((v, i) => i === 0 ? { ...v, route: 'H1' } : v));
    check('declared arm must match executed route', !observe().complete);
    save(input.map((v, i) => i === 0 ? { ...v, fingerprint: { ...v.fingerprint, snapshot: 'changed' } } : v));
    check('different harness inputs do not form a pair', !observe().complete);
    save(input.map((v, i) => i === 0 ? { ...v, sealed: false } : v));
    check('unsealed task cannot enter a routing comparison', !observe().complete);
    save([...input, { ...input[0], task: 'UNKNOWN', finishedAt: '2099-01-01T00:00:00Z' }]);
    check('unplanned outcomes cannot refresh a stale comparison', !observe().complete);
    save(input.map((v, i) => i === 0 ? { ...v, seal: { ...v.seal, checkedAt: finishedAt } } : v));
    check('late sealing cannot enter a routing comparison', !observe().complete);
    write(ledger, '{broken\n');
    r = invoke(['observe']);
    check('malformed ledger fails explicitly', r.status === 1 && /frontier-evidence/.test(r.stderr));
    write(path.join(tasks, 'NEW.json'), JSON.stringify({ id: 'NEW', lane: 'fix', brief: 'NEW.md' }));
    write(path.join(tasks, 'NEW.md'), 'New task.');
    r = invoke(['split', '--tasks-dir', tasks]);
    check('new population cannot overwrite frozen split', r.status === 1 && /split changed/.test(r.stderr));
} catch (e) { check('suite completes', false, e.stack); }
finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`frontier evidence: ${count - failures}/${count} checks passed`);
process.exitCode = failures ? 1 : 0;
