#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const script = path.resolve(__dirname, '../plugins/autodev-core/scripts/frontier-evidence.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-seal-'));
const tasks = path.join(root, 'tasks'), data = path.join(root, 'data'), inputs = path.join(root, 'learning');
let count = 0, failed = 0;
const w = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function check(name, ok, detail) { count++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${!ok ? ': ' + JSON.stringify(detail) : ''}`); }
function invoke(cmd, extra = []) {
    const r = spawnSync(process.execPath, [script, cmd, '--data', data, '--tasks-dir', tasks, ...extra], {
        encoding: 'utf8', windowsHide: true, timeout: 20000,
        env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.join(root, 'home') } });
    return { ...r, value: r.status === 0 && r.stdout ? JSON.parse(r.stdout) : null };
}
function seal() { return invoke('seal', ['--task', 'T2', '--inputs', inputs]); }
try {
    const raw = JSON.stringify({ id: 'T2', lane: 'fix', brief: 'T2.md', expected: 'T2.answers.json', support: [{ from: 'support.md', to: 'PLAN.md' }] });
    const brief = 'Repair the blue fixture.\nKeep its boundary conditions intact.';
    w(path.join(tasks, 'T2.json'), raw);
    w(path.join(tasks, 'T2.md'), brief);
    w(path.join(tasks, 'T2.answers.json'), '{"expected":7}');
    w(path.join(tasks, 'support.md'), 'A unique support plan with its own boundary constraints.');
    w(path.join(inputs, 'lessons.md'), 'Prior learning about an unrelated problem.');
    let r = invoke('split');
    check('split captures content before any run', r.status === 0 && r.value.tasks[0].split === 'held-out', r.stderr);
    const manifest = read(path.join(data, 'routing-split.json'));
    const expected = crypto.createHash('sha256').update(JSON.stringify([raw, brief, '{"expected":7}', 'A unique support plan with its own boundary constraints.'])).digest('hex');
    check('split content hash includes metadata, brief, key and support', manifest.tasks[0].contentHash === expected);
    r = seal();
    const clean = r.value;
    check('unexposed held-out task is sealed with its original hash', r.status === 0 && clean.sealed === true && clean.heldOutHash === expected && clean.seal.currentHash === expected, r);
    check('seal records scanned inputs and pre-run time', clean.seal.files === 1 && clean.seal.checkedAt >= manifest.createdAt && /^[a-f0-9]{64}$/.test(clean.seal.inputsHash));
    w(path.join(inputs, 'lessons.md'), `Learned before evaluation: ${brief}`);
    r = seal();
    check('task text in lessons breaks the seal', r.status === 0 && r.value.sealed === false && r.value.seal.visibleToLearning === true && r.value.seal.hits.length === 1, r.value);
    w(path.join(inputs, 'lessons.md'), 'Unrelated.');
    w(path.join(inputs, 'prompts.jsonl'), JSON.stringify({ prompt: brief }) + '\n');
    r = seal();
    check('escaped task text in a learning prompt breaks the seal', r.value?.sealed === false && r.value.seal.visibleToLearning === true, r.value);
    fs.unlinkSync(path.join(inputs, 'prompts.jsonl'));
    w(path.join(inputs, 'prompt.txt'), brief.replace(/\s+/g, '   '));
    check('whitespace changes cannot hide visible task text', seal().value?.sealed === false);
    fs.unlinkSync(path.join(inputs, 'prompt.txt'));
    w(path.join(inputs, 'lesson.txt'), 'A unique support plan with its own boundary constraints.');
    check('support text is also held out from learning', seal().value?.seal.visibleToLearning === true);
    fs.unlinkSync(path.join(inputs, 'lesson.txt'));
    w(path.join(tasks, 'T2.md'), brief + ' Changed after the split.');
    r = seal();
    check('changed task content is unsealed without replacing its frozen hash', r.value?.sealed === false && r.value.heldOutHash === expected && r.value.seal.contentMatches === false, r.value);
    check('content change leaves original manifest intact', JSON.stringify(read(path.join(data, 'routing-split.json'))) === JSON.stringify(manifest));
    w(path.join(tasks, 'T2.md'), brief);
    w(path.join(tasks, 'T2.answers.json'), '{"expected":8}');
    check('changed answer key invalidates the content seal', seal().value?.sealed === false);
    w(path.join(tasks, 'T2.answers.json'), '{"expected":7}');
    r = invoke('seal', ['--task', 'T2', '--inputs', path.join(root, 'missing-inputs')]);
    check('unreadable required input cannot mean sealed', r.status === 0 && r.value.sealed === false && r.value.seal.errors.length === 1, r.value);
    check('restored task with unrelated learning is sealed again', seal().value?.sealed === true);
    check('previous receipt remains an as-of snapshot', clean.sealed && clean.seal.visibleToLearning === false);
    // A text read failure must be recorded, not silently skipped.
    w(path.join(inputs, 'oversize.txt'), 'x'.repeat(8 * 1024 * 1024 + 1));
    check('bounded scan fails closed on oversized input', seal().value?.sealed === false);
} catch (e) { check('suite completes', false, e.stack); }
finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log(`frontier seal: ${count - failed}/${count} checks passed`);
process.exitCode = failed ? 1 : 0;
