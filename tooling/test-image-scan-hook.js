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
    return { ms, injected: !!ctx, context: ctx, stdoutBytes: stdout.length, exit: res.status };
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

// Timing-only invocation — no logging. Used for the budget samples below, which
// need several measurements of the same case without seven copies of the output.
function timeOnce(transcriptPath, opts = {}) {
    const payload = {
        session_id: 'test',
        transcript_path: transcriptPath,
        cwd: opts.cwd || tmp,
        permission_mode: 'default',
        hook_event_name: 'UserPromptSubmit',
        prompt: opts.prompt || 'test',
    };
    const start = process.hrtime.bigint();
    spawnSync('node', [hook], { input: JSON.stringify(payload), encoding: 'utf8' });
    return Number(process.hrtime.bigint() - start) / 1e6;
}

// --- Run ---
// Kept as specs so the budget check can re-time each case instead of reusing a
// single sample taken here. See the performance-budget note below.
const caseSpecs = [
    ['1. No image (should no-op)', noImage, {}],
    ['2. Single image', withImage, {}],
    ['3. Two images', twoImages, {}],
    ['4. Big transcript (~500 KB) with image at end', big, {}],
    ['5. Auto mode active — quieter directive', withImage, { cwd: autoCwd }],
    ['6. Missing transcript file (should no-op)', missing, {}],
    ['7. Invalid stdin JSON', noImage, { prompt: 'ignored' }],
];
const results = caseSpecs.map(([label, transcriptPath, opts]) => runCase(label, transcriptPath, opts));

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

// --- gaps found by check:vacuity ---
//
// `if (extraContext)` in done() forced to `true` survived every assertion above,
// because they all test whether additionalContext is PRESENT. With the mutant the
// hook still emits a JSON envelope, just an empty one — so `injected` stays false
// and nothing notices. But this hook runs on EVERY prompt under a 150ms budget,
// and emitting an envelope on every turn when there is nothing to say is exactly
// the cost it was written to avoid. Silence is the behaviour, not just "no
// context". Asserting zero bytes is the only way to see the difference.
assert('case 1 writes NOTHING at all (not an empty envelope)', results[0].stdoutBytes === 0);
assert('case 6 writes NOTHING at all (not an empty envelope)', results[5].stdoutBytes === 0);

// A transcript_path that does not exist must short-circuit silently. Nothing
// covered a missing file, so the guard that checks for one could be removed
// without any assertion changing.
{
    const missing = runCase('missing transcript file', path.join(tmp, 'does-not-exist.jsonl'));
    assert('missing transcript: exits 0', missing.exit === 0);
    assert('missing transcript: silent', missing.stdoutBytes === 0);
}

// The scan must find the USER's images, not whatever record comes first.
// `msg && msg.role === 'user' && Array.isArray(msg.content)` forced to `true`
// takes the newest record regardless of role, so an assistant turn carrying an
// image would be reported as if the user had just sent it — announcing an image
// the user never attached, and costing a read of it.
{
    const assistantImage = writeFixture('assistant-image.jsonl', [
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'plain question' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [
            { type: 'text', text: 'here is a chart' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ] } },
    ]);
    const r = runCase("assistant's image is not the user's", assistantImage);
    assert('an assistant image is not announced as the user\'s', !r.injected);
    assert('  and nothing is written', r.stdoutBytes === 0);
}
assert('case 5 uses auto-mode directive', results[4].context.includes('AUTO MODE IS ACTIVE'));
assert('case 2 uses base directive (not auto)', !results[1].context.includes('AUTO MODE IS ACTIVE'));

// Performance budget.
//
// A fixed wall-clock threshold flakes: most of each run is Node process startup,
// which swings by 5-10x between an idle laptop and a loaded CI runner. Measure
// this machine's bare `node` startup first and budget the hook's OWN work
// against that, so the assertion tracks the thing that can actually regress.
const timeBareNode = () => {
    const t0 = process.hrtime.bigint();
    spawnSync('node', ['-e', ''], { encoding: 'utf8' });
    return Number(process.hrtime.bigint() - t0) / 1e6;
};

// The allowance for the hook's OWN work, on top of whatever Node startup costs
// right now. Deliberately unchanged: raising it hides a real regression of up to
// the new margin, which the note below already rejected once.
const OWN_WORK_BUDGET_MS = 150;

console.log('');
console.log('Node startup, min of 3 taken now: ' + Math.min(timeBareNode(), timeBareNode(), timeBareNode()).toFixed(1) + ' ms');

// Compare FLOOR to FLOOR, and never on a single sample.
//
// This suite failed twice in ~8 full `test-all` runs and never once standalone,
// which read as a mystery until the distribution was measured on 2026-08-17: the
// same invocation sits at 33-37 ms with observed spikes to 68 and 84 ms — a 2.3x
// tail from OS scheduling and disk, not from the hook. The assertion rested on
// ONE sample per case against a ~180 ms budget, so a single rare outlier failed
// the suite while the hook was healthy.
//
// min-of-3 pins the reported number to the floor: measured over 84 samples the
// worst single sample was 68 ms while the worst min-of-3 was 36.2 ms. The floor
// still moves if the hook genuinely regresses, which is the thing being tested;
// the tail no longer decides whether the suite is green. The baseline above is a
// min-of-3 too, so both sides of the comparison are floors and neither depends on
// how loaded the machine happened to be.
//
// Rejected: raising the 150 ms constant. That hides a real regression of up to
// the new margin and would still flake on a large enough spike.
//
// `[measured 2026-08-25]` The min-of-3 above was still not enough, and the reason
// is a flaw in HOW the two floors were compared rather than in the floors
// themselves. This failed under a full `test-all` at samples 286/475/437 against
// a 202 ms budget: ALL THREE were slow, so taking the minimum could not help.
//
// The baseline was measured ONCE, up front, and then compared against timings
// taken later. When load rises in between, the two sides of the comparison are
// measured under different conditions, which is precisely what the note above
// claimed could not happen. A stale floor is not a floor.
//
// TWO MORE ATTEMPTS FAILED HERE. Both are recorded because each looked correct
// and each was disproved by running it, which is cheaper to read than to repeat.
//
// Attempt 2, min of the per-pair DIFFERENCES: biased low. The minimum lands on
// whichever pair had the slowest baseline, and it produced -182.8 ms from a pair
// of 60 ms hook against 243 ms bare node. An assertion that can go hundreds of
// milliseconds negative sails through the regression it exists to catch.
//
// Attempt 3, interleaved floor-to-floor, min(total) - min(bare): still flakes. It
// reported 188.6 ms from floors of 234 total against 46 bare, on an UNMUTATED
// hook. Alternating samples can land on opposite phases when load oscillates
// faster than the sampling, so the two floors are not comparable even when taken
// in the same window.
//
// THE ROOT PROBLEM: no wall-clock comparison across separate process spawns is
// reliable on a loaded machine, because the samples are not simultaneous and the
// load varies on a shorter timescale than the sampling. More samples raise the
// cost without removing the failure.
//
// So this now REFUSES TO JUDGE when the machine is too noisy to time anything,
// and says so. Detected from the baseline's own spread, which needs no knowledge
// of the hook. A budget that reports NOT MEASURED under load never produces a
// false red, and a false red is worse than a false green here: it looks like
// diligence, so it gets acted on, and the action is a change to working code.
const TIMING_SAMPLES = 5;
const NOISE_CEILING = 2.5;   // max/min bare-node spread we will still time under
let timedCases = 0;

for (let i = 0; i < caseSpecs.length; i++) {
    const [, transcriptPath, opts] = caseSpecs[i];
    const totals = [];
    const bares = [];
    for (let s = 0; s < TIMING_SAMPLES; s++) {
        bares.push(timeBareNode());
        totals.push(timeOnce(transcriptPath, opts));
    }
    const bareFloor = Math.min(...bares);
    const spread = Math.max(...bares) / bareFloor;
    const ownWork = Math.min(...totals) - bareFloor;

    if (spread > NOISE_CEILING) {
        // Worded as a deficiency, not a category. "Not applicable" invites
        // agreement; NOT MEASURED invites someone to re-run it on a quiet box.
        console.log('  NOT MEASURED  case ' + (i + 1) + ' timing is unjudgeable: bare-node spread '
            + spread.toFixed(1) + 'x over ' + TIMING_SAMPLES + ' samples (ceiling '
            + NOISE_CEILING + 'x). The machine is too loaded to time a subprocess.');
        continue;
    }
    timedCases++;
    assert(
        'case ' + (i + 1) + ' own work within budget (' + ownWork.toFixed(1) + ' ms of '
        + OWN_WORK_BUDGET_MS + ' ms; floors ' + Math.min(...totals).toFixed(0) + ' total - '
        + bareFloor.toFixed(0) + ' bare, spread ' + spread.toFixed(1) + 'x)',
        ownWork < OWN_WORK_BUDGET_MS
    );
}

// Skipping every case is not a pass. If the machine was too loaded to time even
// one, this check had NO subject, and a gate with no subject reporting green is
// how absent coverage becomes reported coverage. Fail instead, so somebody re-runs
// it somewhere quiet rather than reading silence as health.
assert(
    'the timing budget had at least one measurable case (' + timedCases + ' of '
    + caseSpecs.length + ' timed; the rest were too noisy)',
    timedCases > 0
);

// --- the error path. fail() was reported never entered by check:functions.
//
// The hook wraps its whole body in a try and routes any throw through fail(),
// which must still exit 0 and stay silent — a UserPromptSubmit hook that errors
// loudly costs the user a turn. Forced by handing it a transcript_path that is a
// DIRECTORY: readFileSync throws EISDIR inside the body, which the malformed-JSON
// case never reaches because that is guarded earlier.
{
    const dirPath = path.join(tmp, 'transcript-is-a-directory');
    fs.mkdirSync(dirPath, { recursive: true });
    const r = runCase('transcript path is a directory', dirPath);
    assert('an unreadable transcript exits 0', r.exit === 0);
    assert('  and stays silent', r.stdoutBytes === 0);
}

console.log('');
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAIL');
process.exit(fails === 0 ? 0 : 1);
