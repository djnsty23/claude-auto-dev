#!/usr/bin/env node
// Suite for hooks/queue-drained.js - the PostToolUse hook that reports the
// options-protocol queue after a commit.
//
// Two halves, and the second is the one that matters:
//   GATING   the hook must stay SILENT on every Bash call that is not a commit.
//            A hook that narrates on every shell call gets muted, and a muted
//            hook catches nothing - so silence is a behaviour under test, not
//            an absence of one.
//   FINDING  given a real commit and a transcript that carries an item forward,
//            it must name that item.
//
// Every case also asserts exit 0: PostToolUse informs, it must never block a
// commit that already succeeded.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const hook = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'queue-drained.js');
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

function run(command, transcriptPath) {
    const res = spawnSync('node', [hook], {
        input: JSON.stringify({
            session_id: 'test',
            transcript_path: transcriptPath,
            cwd: tmp,
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command },
            tool_response: { stdout: '', stderr: '' },
        }),
        encoding: 'utf8',
        windowsHide: true,
    });
    return { out: (res.stdout || '').trim(), err: (res.stderr || '').trim(), exit: res.status };
}

const CARRIED = 'Write up the session as a lessons entry';
const carriedTranscript = fixture('carried.jsonl', [
    [[CARRIED, 'Merge #36, then #37', 'Stop here'], [CARRIED, 'Merge #36, then #37']],
    [[CARRIED, 'Something else'], [CARRIED]],
]);
const cleanTranscript = fixture('clean.jsonl', [
    [['Merge #36, then #37', 'Stop here'], ['Merge #36, then #37']],
]);

console.log('\n=== gating: only a real commit may speak ===');

for (const cmd of ['git log --oneline -5', 'git status --short', 'npm run commit', 'git diff --stat HEAD']) {
    const r = run(cmd, carriedTranscript);
    check(`silent on: ${cmd}`, r.out === '' && r.exit === 0, `exit=${r.exit} out=${JSON.stringify(r.out.slice(0, 80))}`);
}

{
    const r = run('git commit --dry-run -m x', carriedTranscript);
    check('silent on: --dry-run', r.out === '' && r.exit === 0, `exit=${r.exit} out=${JSON.stringify(r.out.slice(0, 80))}`);
}

console.log('\n=== gating: these ARE commits and must report ===');

for (const cmd of [
    'git commit -m "feat: x"',
    'git commit --amend --no-edit',
    'git -C /c/repo commit -m x',            // regression: an options-only regex missed this
    'git add -A && git commit -m x',
]) {
    const r = run(cmd, carriedTranscript);
    check(`fires on: ${cmd}`, r.out.includes('[queue]') && r.exit === 0, `exit=${r.exit} out=${JSON.stringify(r.out.slice(0, 80))}`);
}

console.log('\n=== finding: it names the carried item ===');

{
    const r = run('git commit -m x', carriedTranscript);
    check('reports CARRIED FORWARD', r.out.includes('CARRIED FORWARD'), `out=${JSON.stringify(r.out.slice(0, 160))}`);
    check('names the carried label', r.out.includes(CARRIED), 'label absent from output');
    check('prints the population scanned', /\d+ answered panel\(s\) scanned/.test(r.out), 'no population line');
    check('exits 0 even when it has a finding', r.exit === 0, `exit=${r.exit}`);
}

{
    const r = run('git commit -m x', cleanTranscript);
    check('stays quiet when nothing carried', !r.out.includes('CARRIED FORWARD'), `out=${JSON.stringify(r.out.slice(0, 160))}`);
    check('still prints the population', /\d+ answered panel\(s\) scanned/.test(r.out), 'no population line');
}

console.log('\n=== could-not-run is reported, never passed silently ===');

{
    const r = run('git commit -m x', path.join(tmp, 'does-not-exist.jsonl'));
    check('says NOT RUN on a missing transcript', r.out.includes('NOT RUN'), `out=${JSON.stringify(r.out.slice(0, 120))}`);
    check('exits 0 on a missing transcript', r.exit === 0, `exit=${r.exit}`);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

const total = 15;
console.log(`\ntest-queue-drained: ${failures ? `FAIL (${failures} of ${total})` : `PASS (${total} assertions)`}\n`);
process.exit(failures ? 1 : 0);
