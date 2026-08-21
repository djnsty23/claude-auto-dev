#!/usr/bin/env node
// Suite for the post-commit queue report, which rides inside hooks/telemetry.js
// rather than carrying its own hook. telemetry.js already spawns on every tool
// call; a dedicated PostToolUse hook on Bash measured ~56ms per Bash call for a
// report that fires only on commits.
//
// Three things under test, and the second is the one that matters:
//
//   GATING     silent on every Bash call that is not a commit. A check that
//              speaks on every shell call gets muted, and a muted check catches
//              nothing - so silence is a behaviour, not an absence of one.
//   FINDING    given a commit and a transcript that carries an item forward, it
//              names that item.
//   ONE WRITE  telemetry.js now has two riders sharing one stdout. Two JSON
//              objects on one stream is unparseable output, so a call that
//              triggers BOTH must still emit exactly one valid object.
//
// Every case asserts exit 0: telemetry informs, and must never be why a tool
// call - or a commit that already succeeded - looks failed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'telemetry.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'queuedrained-'));

let failures = 0;
function check(name, cond, detail) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' - ' + detail}`);
    if (!cond) failures++;
}

/** A transcript in the shape the real tool emits. */
function fixture(name, panels) {
    const recs = [];
    panels.forEach(([labels, picks], i) => {
        recs.push({ message: { content: [{
            type: 'tool_use', id: `p${i}`, name: 'AskUserQuestion',
            input: { questions: [{ options: labels.map((l) => ({ label: l })) }] },
        }] } });
        recs.push({ message: { content: [{
            type: 'tool_result', tool_use_id: `p${i}`,
            content: `Your questions have been answered: "Q"="${picks.join(',')}". You can now continue.`,
        }] } });
    });
    const p = path.join(tmp, name);
    fs.writeFileSync(p, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return p;
}

function run(command, transcriptPath, opts = {}) {
    const res = spawnSync('node', [hook], {
        input: JSON.stringify({
            session_id: 'test',
            transcript_path: transcriptPath,
            cwd: tmp,
            hook_event_name: 'PostToolUse',
            tool_name: opts.tool || 'Bash',
            tool_input: { command },
            tool_response: opts.response !== undefined ? opts.response : { stdout: '', is_error: false },
        }),
        encoding: 'utf8',
        cwd: tmp,                 // telemetry writes .claude/reports under cwd
        windowsHide: true,
    });
    const stdout = (res.stdout || '').trim();
    let parsed = null;
    let parseError = null;
    if (stdout) {
        try { parsed = JSON.parse(stdout); } catch (e) { parseError = e.message; }
    }
    const ctx = (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
    return { stdout, parsed, parseError, ctx, exit: res.status };
}

const CARRIED = 'Write up the session as a lessons entry';
const carried = fixture('carried.jsonl', [
    [[CARRIED, 'Merge #36, then #37', 'Stop here'], [CARRIED, 'Merge #36, then #37']],
    [[CARRIED, 'Something else'], [CARRIED]],
]);
const clean = fixture('clean.jsonl', [
    [['Merge #36, then #37', 'Stop here'], ['Merge #36, then #37']],
]);

console.log('\n=== gating: only a real commit may speak ===');

for (const cmd of ['git log --oneline -5', 'git status --short', 'npm run commit', 'git diff --stat HEAD']) {
    const r = run(cmd, carried);
    check(`silent on: ${cmd}`, !r.ctx.includes('[queue]') && r.exit === 0, `exit=${r.exit} ctx=${JSON.stringify(r.ctx.slice(0, 80))}`);
}

{
    const r = run('git commit --dry-run -m x', carried);
    check('silent on: --dry-run', !r.ctx.includes('[queue]'), `ctx=${JSON.stringify(r.ctx.slice(0, 80))}`);
}

{
    // Same command text, wrong tool - the gate is on BOTH, not on the string alone.
    const r = run('git commit -m x', carried, { tool: 'Read' });
    check('silent when the tool is not Bash', !r.ctx.includes('[queue]'), `ctx=${JSON.stringify(r.ctx.slice(0, 80))}`);
}

console.log('\n=== gating: these ARE commits and must report ===');

for (const cmd of [
    'git commit -m "feat: x"',
    'git commit --amend --no-edit',
    'git -C /c/repo commit -m x',            // regression: an options-only regex missed this
    'git add -A && git commit -m x',
]) {
    const r = run(cmd, carried);
    check(`fires on: ${cmd}`, r.ctx.includes('[queue]') && r.exit === 0, `exit=${r.exit} ctx=${JSON.stringify(r.ctx.slice(0, 80))}`);
}

console.log('\n=== finding: it names the carried item ===');

{
    const r = run('git commit -m x', carried);
    check('reports CARRIED FORWARD', r.ctx.includes('CARRIED FORWARD'), `ctx=${JSON.stringify(r.ctx.slice(0, 200))}`);
    check('names the carried label', r.ctx.includes(CARRIED), 'label absent');
    check('prints the population scanned', /\d+ answered panel\(s\) scanned/.test(r.ctx), 'no population line');
    check('exits 0 even when it has a finding', r.exit === 0, `exit=${r.exit}`);
}

{
    const r = run('git commit -m x', clean);
    check('stays quiet when nothing carried', !r.ctx.includes('CARRIED FORWARD'), `ctx=${JSON.stringify(r.ctx.slice(0, 200))}`);
    check('still prints the population', /\d+ answered panel\(s\) scanned/.test(r.ctx), 'no population line');
}

console.log('\n=== could-not-run is reported, never passed silently ===');

{
    const r = run('git commit -m x', path.join(tmp, 'does-not-exist.jsonl'));
    check('says NOT RUN on a missing transcript', r.ctx.includes('NOT RUN'), `ctx=${JSON.stringify(r.ctx.slice(0, 120))}`);
    check('exits 0 on a missing transcript', r.exit === 0, `exit=${r.exit}`);
}

console.log('\n=== two riders, one stdout ===');

{
    // A FAILED Bash call carrying the /tmp signature triggers the failure
    // advisory; the same call being a commit triggers the queue report. Both at
    // once is the case that would emit two JSON objects if anyone unpicks the
    // single-write discipline in telemetry.js.
    const r = run('git commit -m x && cat /tmp/x.json', carried, {
        response: { stdout: '', stderr: 'ENOENT: no such file or directory, open \'C:\\tmp\\x.json\'', is_error: true },
    });
    // Assert BOTH riders are actually present first. Without this, "one JSON
    // object" passes vacuously whenever only one rider fired - which is most of
    // the time, and would make this whole case decorative.
    check('the failure advisory fired', r.ctx.includes('Windows /tmp split'), `ctx=${JSON.stringify(r.ctx.slice(0, 200))}`);
    check('the queue report fired too', r.ctx.includes('[queue]'), `ctx=${JSON.stringify(r.ctx.slice(0, 200))}`);
    check('stdout is still ONE parseable JSON object', r.parseError === null, `parse error: ${r.parseError}`);
    check('exits 0 with both riders firing', r.exit === 0, `exit=${r.exit}`);
}

console.log('\n=== telemetry itself still works ===');

{
    run('git status --short', carried);
    const dir = path.join(tmp, '.claude', 'reports');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('telemetry-')) : [];
    check('the telemetry line is still written', files.length > 0, 'no telemetry-*.jsonl produced');
}

console.log('\n=== stop hook: the exact finding rides on the decision ===');

const stopHook = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'stop-auto-check.js');

function runStop(transcriptPath) {
    const dir = fs.mkdtempSync(path.join(tmp, 'stop-'));   // no auto-active flag => approve
    const res = spawnSync('node', [stopHook], {
        input: JSON.stringify({
            session_id: 'test',
            transcript_path: transcriptPath,
            cwd: dir,
            hook_event_name: 'Stop',
            stop_hook_active: false,
        }),
        encoding: 'utf8',
        cwd: dir,
        windowsHide: true,
    });
    const stdout = (res.stdout || '').trim();
    let parsed = null;
    let parseError = null;
    try { parsed = JSON.parse(stdout); } catch (e) { parseError = e.message; }
    return { stdout, parsed, parseError, exit: res.status };
}

{
    const r = runStop(carried);
    check('stop output is still ONE parseable JSON object', r.parseError === null, `parse error: ${r.parseError} stdout=${JSON.stringify(r.stdout.slice(0, 120))}`);
    check('the decision survives untouched', !!r.parsed && r.parsed.decision === 'approve', `decision=${r.parsed && r.parsed.decision}`);
    check('systemMessage names the carried item', !!r.parsed && String(r.parsed.systemMessage || '').includes(CARRIED), `systemMessage=${JSON.stringify(r.parsed && r.parsed.systemMessage)}`);
    check('systemMessage carries no decision of its own', !!r.parsed && !('reason' in r.parsed), 'a reason field appeared on an approve');
}

{
    const r = runStop(clean);
    check('silent at stop when nothing carried', !!r.parsed && r.parsed.systemMessage === undefined, `systemMessage=${JSON.stringify(r.parsed && r.parsed.systemMessage)}`);
    check('and the decision is still emitted', !!r.parsed && r.parsed.decision === 'approve', `decision=${r.parsed && r.parsed.decision}`);
}

{
    // A missing transcript must not change the decision, and must not throw.
    const r = runStop(path.join(tmp, 'nope.jsonl'));
    check('a missing transcript still approves', !!r.parsed && r.parsed.decision === 'approve', `decision=${r.parsed && r.parsed.decision}`);
    check('a missing transcript adds no systemMessage', !!r.parsed && r.parsed.systemMessage === undefined, 'systemMessage present');
}

console.log('\n=== --sweep over a controlled population ===');

{
    // A projects root with exactly two sessions: one carrying an item forward,
    // one clean. Controlled, so the counts below are exact rather than "some".
    const root = path.join(tmp, 'projects');
    fs.mkdirSync(path.join(root, 'proj-a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'proj-b'), { recursive: true });
    fs.copyFileSync(carried, path.join(root, 'proj-a', 'aaaaaaaa-1111.jsonl'));
    fs.copyFileSync(clean, path.join(root, 'proj-b', 'bbbbbbbb-2222.jsonl'));
    // A file with no panel at all, to prove the prefilter counts it as skipped
    // rather than silently dropping it from the population.
    fs.writeFileSync(path.join(root, 'proj-b', 'cccccccc-3333.jsonl'), JSON.stringify({ message: { content: [] } }) + '\n');

    const script = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-queue-drained.js');
    const res = spawnSync('node', [script, '--sweep', '--root', root], { encoding: 'utf8', windowsHide: true });
    const out = res.stdout || '';

    check('sweep prints the population it walked', /2 project dir\(s\), 3 transcript\(s\)/.test(out), `out=${JSON.stringify(out.slice(0, 200))}`);
    check('sweep separates analysed from skipped', /2 held a panel[^\n]*1 had none/.test(out), `out=${JSON.stringify(out.slice(0, 300))}`);
    check('sweep names the carried item', out.includes(CARRIED), 'carried label absent');
    check('sweep counts exactly one open item', /OPEN AT SESSION END: 1 item/.test(out), `out=${JSON.stringify(out.slice(0, 400))}`);
    check('sweep does not flag the clean session', !out.includes('proj-b'), 'clean session appeared in findings');
    check('sweep exits 0', res.status === 0, `exit=${res.status}`);
}

{
    // An unreadable root must say so, not report a clean sweep.
    const script = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-queue-drained.js');
    const res = spawnSync('node', [script, '--sweep', '--root', path.join(tmp, 'no-such-root')], { encoding: 'utf8', windowsHide: true });
    check('sweep says NOT RUN on a missing root', (res.stdout || '').includes('NOT RUN'), `out=${JSON.stringify((res.stdout || '').slice(0, 120))}`);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

const total = 36;
console.log(`\ntest-queue-drained: ${failures ? `FAIL (${failures} of ${total})` : `PASS (${total} assertions)`}\n`);
process.exit(failures ? 1 : 0);
