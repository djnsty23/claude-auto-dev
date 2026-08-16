#!/usr/bin/env node
// Test harness for user-prompt-image-scan.js
// Runs 4 scenarios, prints output + timing. Creates temp JSONL fixtures.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imgscan-'));
const hook = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'user-prompt-image-scan.js');

function writeFixture(name, lines) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, lines.map(JSON.stringify).join('\n') + '\n');
    return p;
}

function runCase(label, transcriptPath, opts = {}) {
    const payload = {
        session_id: 'test',
        transcript_path: transcriptPath,
        cwd: opts.cwd || tmp,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: opts.prompt || 'test',
    };
    const start = process.hrtime.bigint();
    const res = spawnSync('node', [hook], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const stdout = res.stdout.trim();
    let parsed = null;
    if (stdout) {
        try { parsed = JSON.parse(stdout); } catch {}
    }
    console.log('');
    console.log('=== ' + label + ' ===');
    console.log('  exit: ' + res.status + '  time: ' + ms.toFixed(1) + ' ms');
    console.log('  stdout bytes: ' + stdout.length);
    if (res.stderr.trim()) console.log('  stderr: ' + res.stderr.trim());
    if (parsed && parsed.hookSpecificOutput) {
        const ctx = parsed.hookSpecificOutput.additionalContext || '';
        console.log('  additionalContext: ' + ctx.length + ' chars');
        console.log('  preview: ' + ctx.slice(0, 120).replace(/\n/g, ' ') + '...');
    } else if (stdout) {
        console.log('  raw stdout: ' + stdout.slice(0, 120));
    } else {
        console.log('  (no output — no-op)');
    }
    const ctx = parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext || '';
    return { ms, injected: !!ctx, context: ctx };
}

// --- Fixtures ---
const noImage = writeFixture('no-image.jsonl', [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'just text' }] } },
]);

const withImage = writeFixture('with-image.jsonl', [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'earlier' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
    { type: 'user', message: { role: 'user', content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] } },
]);

const twoImages = writeFixture('two-images.jsonl', [
    { type: 'user', message: { role: 'user', content: [
        { type: 'text', text: 'two shots' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
    ] } },
]);

// Big transcript — 5000 earlier lines + image at the end. Tests tail-read path.
const bigLines = [];
for (let i = 0; i < 5000; i++) {
    bigLines.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'filler line ' + i + ' '.repeat(40) }] } });
    bigLines.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply ' + i + ' '.repeat(40) }] } });
}
bigLines.push({ type: 'user', message: { role: 'user', content: [
    { type: 'text', text: 'final turn with image' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } },
] } });
const big = writeFixture('big-transcript.jsonl', bigLines);
console.log('Big transcript size: ' + (fs.statSync(big).size / 1024).toFixed(1) + ' KB');

// Auto mode fixture — create .claude/auto-active in a temp cwd
const autoCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'imgscan-auto-'));
fs.mkdirSync(path.join(autoCwd, '.claude'), { recursive: true });
fs.writeFileSync(path.join(autoCwd, '.claude', 'auto-active'), '');

// Missing transcript
const missing = path.join(tmp, 'does-not-exist.jsonl');

// --- Run ---
const results = [];
results.push(runCase('1. No image (should no-op)', noImage));
results.push(runCase('2. Single image', withImage));
results.push(runCase('3. Two images', twoImages));
results.push(runCase('4. Big transcript (~500 KB) with image at end', big));
results.push(runCase('5. Auto mode active — quieter directive', withImage, { cwd: autoCwd }));
results.push(runCase('6. Missing transcript file (should no-op)', missing));
results.push(runCase('7. Invalid stdin JSON', noImage, { prompt: 'ignored' }));

// --- Assertions ---
console.log('');
console.log('=== Assertions ===');
let fails = 0;
function assert(label, cond) {
    console.log((cond ? '  OK  ' : '  FAIL') + ' ' + label);
    if (!cond) fails++;
}
assert('case 1 no injection', !results[0].injected);
assert('case 2 injects', results[1].injected);
assert('case 3 injects', results[2].injected);
assert('case 4 injects', results[3].injected);
assert('case 5 injects', results[4].injected);
assert('case 6 no injection', !results[5].injected);
assert('case 3 reports 2 images', results[2].context.includes('2 images'));
assert('case 5 uses auto-mode directive', results[4].context.includes('AUTO MODE IS ACTIVE'));
assert('case 2 uses base directive (not auto)', !results[1].context.includes('AUTO MODE IS ACTIVE'));

// Performance budget.
//
// A fixed wall-clock threshold flakes: most of each run is Node process startup,
// which swings by 5-10x between an idle laptop and a loaded CI runner. Measure
// this machine's bare `node` startup first and budget the hook's OWN work
// against that, so the assertion tracks the thing that can actually regress.
const baselineRuns = [];
for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync('node', ['-e', ''], { encoding: 'utf8' });
    baselineRuns.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
const baseline = Math.min(...baselineRuns);
const budget = baseline + 150;

console.log('');
console.log('Node startup baseline: ' + baseline.toFixed(1) + ' ms  →  budget ' + budget.toFixed(1) + ' ms');

for (let i = 0; i < results.length; i++) {
    assert(
        'case ' + (i + 1) + ' within budget (' + results[i].ms.toFixed(1) + ' ms of ' + budget.toFixed(1) + ' ms)',
        results[i].ms < budget
    );
}

console.log('');
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAIL');
process.exit(fails === 0 ? 0 : 1);
