#!/usr/bin/env node
// Suite for hooks/stop-workflow-wall-note.js.
//
// Drives the hook as a SUBPROCESS with real stdin, real run directories built
// by tooling/fixtures/workflow-runs.js, and a real ledger file, because every
// decision it makes is a read of something on disk.
//
// The assertions that matter most are the SILENT ones. A Stop hook that speaks
// when it should not is a hook the operator learns to skip. Each quiet path
// asserts ZERO BYTES on stdout AND stderr, not merely "no context": mutants
// have survived in this repo because a test checked one stream.
//
// The four fixture kinds the brief asked for: a journaled run, a lost-quota
// run, a lost-other run, an unreadable one. Plus the control that the fixture
// is what fired it: strip the synthetic row and the same hook goes silent;
// rename the run and the message names the new id.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeRun } = require('./fixtures/workflow-runs.js');

const HOOK = path.join(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'stop-workflow-wall-note.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
    if (ok) { pass++; console.log('PASS  ' + name); }
    else { fail++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
};

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function ledgerFile() { return path.join(tmp('wall-ledger-'), 'state.json'); }

function fire({ input, ledger, env }) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: typeof input === 'string' ? input : JSON.stringify(input),
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
            AUTODEV_WORKFLOW_WALL_STATE: ledger,
            AUTODEV_WORKFLOW_WALL: '',
        }, env || {}),
    });
    return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

function silentOk(r) { return r.out.length === 0 && r.err.length === 0 && r.status === 0; }

/** The parsed note, or null if the hook did not speak in the expected non-blocking shape. */
function spoke(r) {
    if (r.status !== 0 || r.err.length !== 0) return null;
    try {
        const j = JSON.parse(r.out);
        if ('decision' in j) return null; // a blocking key is a defect, never a note
        const ctx = j && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext;
        return typeof ctx === 'string' && typeof j.systemMessage === 'string' && j.hookSpecificOutput.hookEventName === 'Stop' ? j : null;
    } catch {
        return null;
    }
}

const wallAgents = [
    { id: 'a1000000000000001', key: 'v2:k1', journaled: false, marker: 'wall', secs: 46, tools: 12 },
    { id: 'a1000000000000002', key: 'v2:k2', journaled: false, marker: 'wall', secs: 40, tools: 12 },
    { id: 'a1000000000000003', key: 'v2:k3', journaled: true, secs: 2000, tools: 100 },
];

// --- inert paths -------------------------------------------------------------
{
    const ledger = ledgerFile();
    check('unparseable stdin: silent, exit 0', silentOk(fire({ input: 'not json', ledger })));
    check('no session_id: silent', silentOk(fire({ input: { transcript_path: '/nowhere/x.jsonl' }, ledger })));
    check('no transcript_path: silent', silentOk(fire({ input: { session_id: 's' }, ledger })));
    check('session with no workflow runs: silent', silentOk(fire({ input: { session_id: 's', transcript_path: path.join(tmp('wall-none-'), 's.jsonl') }, ledger })));
}

// --- a journaled run: nothing to say ----------------------------------------
{
    const ledger = ledgerFile();
    const f = makeRun(tmp('wall-ok-'), { sessionId: 'sess-ok', runId: 'wf_aaaa0000-001', agents: [
        { id: 'a2000000000000001', journaled: true, secs: 100, tools: 4 },
        { id: 'a2000000000000002', journaled: true, secs: 100, tools: 4 },
    ] });
    const r = fire({ input: { session_id: 'sess-ok', transcript_path: f.transcriptPath }, ledger });
    check('journaled run: zero bytes on both streams', silentOk(r), `out=${r.out.length}B err=${r.err.length}B`);
}

// --- a run lost to something other than the wall: not this hook's business --
{
    const ledger = ledgerFile();
    const f = makeRun(tmp('wall-other-'), { sessionId: 'sess-other', runId: 'wf_bbbb0000-002', agents: [
        { id: 'a3000000000000001', journaled: false, marker: 'interrupt', secs: 300, tools: 10 },
        { id: 'a3000000000000002', journaled: false, marker: null, secs: 300, tools: 10 },
        { id: 'a3000000000000003', journaled: false, marker: 'api', secs: 30, tools: 1 },
    ] });
    const r = fire({ input: { session_id: 'sess-other', transcript_path: f.transcriptPath }, ledger });
    check('lost-other run (interrupt, no marker, non-limit api error): silent', silentOk(r), `out=${r.out.slice(0, 120)}`);
}

// --- an unreadable latest run ------------------------------------------------
{
    const ledger = ledgerFile();
    const f = makeRun(tmp('wall-unread-'), { sessionId: 'sess-u', runId: 'wf_cccc0000-003', agents: wallAgents });
    // A newer "run" that is a plain file: the latest entry is unreadable.
    const bogus = path.join(path.dirname(f.runDir), 'wf_dddd0000-004');
    fs.writeFileSync(bogus, 'not a directory');
    const later = Date.now();
    fs.utimesSync(bogus, new Date(later), new Date(later));
    const r = fire({ input: { session_id: 'sess-u', transcript_path: f.transcriptPath }, ledger });
    check('unreadable latest run: silent, exit 0 (never a crash, never a guess)', silentOk(r), `out=${r.out.slice(0, 120)} err=${r.err.slice(0, 120)}`);
}

// --- the case it exists for: lost to the wall ------------------------------
{
    const ledger = ledgerFile();
    const projects = tmp('wall-hit-');
    const f = makeRun(projects, { sessionId: 'sess-hit', runId: 'wf_eeee0000-005', name: 'geometry', agents: wallAgents });
    const r = fire({ input: { session_id: 'sess-hit', transcript_path: f.transcriptPath }, ledger });
    const j = spoke(r);
    check('wall run: speaks, in the non-blocking shape (systemMessage + additionalContext, no decision)', !!j, r.out.slice(0, 300) + r.err.slice(0, 200));
    check('wall run: exit 0', r.status === 0);
    const ctx = j ? j.hookSpecificOutput.additionalContext : '';
    check('wall run: names the run id', ctx.includes('wf_eeee0000-005') && j.systemMessage.includes('wf_eeee0000-005'), ctx.slice(0, 200));
    check('wall run: names the exact resume call with the script file', ctx.includes(`Workflow({scriptPath: ${JSON.stringify(f.scriptPath)}, resumeFromRunId: "wf_eeee0000-005"})`), ctx);
    check('wall run: says how many were lost and how many are cached', /LOST 2 AGENT\(S\)/.test(ctx) && /1 of 3 agent\(\) calls have a journaled result/.test(ctx), ctx);
    check('wall run: operator line carries the cost', /86 agent-seconds and 24 tool calls/.test(j.systemMessage), j.systemMessage);
    check('wall run: tells the model not to relaunch fresh', /Do NOT re-send the script/.test(ctx), ctx);

    const again = fire({ input: { session_id: 'sess-hit', transcript_path: f.transcriptPath }, ledger });
    check('same loss on the next turn: silent (spoke once)', silentOk(again), `out=${again.out.length}B`);

    // A resume that lost a DIFFERENT agent (the real case: 5 to the wall, then 1 to an interrupt).
    makeRun(projects, { sessionId: 'sess-hit', runId: 'wf_eeee0000-005', name: 'geometry', agents: wallAgents.concat([
        { id: 'a1000000000000004', key: 'v2:k1', journaled: false, marker: 'interrupt', secs: 2305, tools: 127 },
    ]) });
    const changed = fire({ input: { session_id: 'sess-hit', transcript_path: f.transcriptPath }, ledger });
    const j2 = spoke(changed);
    check('a changed loss set: speaks once more', !!j2 && /AND 1 TO SOMETHING ELSE/.test(j2.hookSpecificOutput.additionalContext), changed.out.slice(0, 300));
    check('and is silent again after that', silentOk(fire({ input: { session_id: 'sess-hit', transcript_path: f.transcriptPath }, ledger })));

    // Ledger content is what throttles, and it is per session and run.
    const led = JSON.parse(fs.readFileSync(ledger, 'utf8'));
    check('ledger keyed by session and run id', Object.keys(led).length === 1 && Object.keys(led)[0] === 'sess-hit:wf_eeee0000-005', JSON.stringify(led));
}

// --- CONTROL: the fixture is what fired it -----------------------------------
{
    const projects = tmp('wall-ctl-');
    const f = makeRun(projects, { sessionId: 'sess-ctl', runId: 'wf_ffff0000-006', agents: wallAgents });
    // Same fixture, synthetic rows removed: silent.
    for (const id of ['a1000000000000001', 'a1000000000000002']) {
        const file = path.join(f.runDir, 'agent-' + id + '.jsonl');
        const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.includes('<synthetic>'));
        fs.writeFileSync(file, kept.join('\n') + '\n');
        const old = Date.now() - 3600 * 1000;
        fs.utimesSync(file, new Date(old), new Date(old));
    }
    const r = fire({ input: { session_id: 'sess-ctl', transcript_path: f.transcriptPath }, ledger: ledgerFile() });
    check('control: same run without the synthetic rows is silent (still lost, not to the wall)', silentOk(r), r.out.slice(0, 200));

    // Same agents under a different run id: the message follows the id.
    const g = makeRun(projects, { sessionId: 'sess-ctl2', runId: 'wf_9999aaaa-007', agents: wallAgents });
    const r2 = fire({ input: { session_id: 'sess-ctl2', transcript_path: g.transcriptPath }, ledger: ledgerFile() });
    const j = spoke(r2);
    check('control: a renamed run is named by its new id', !!j && j.systemMessage.includes('wf_9999aaaa-007') && !j.systemMessage.includes('wf_ffff0000-006'), r2.out.slice(0, 200));
}

// --- in flight, latest-only, and the off switch -----------------------------
{
    const projects = tmp('wall-flight-');
    const f = makeRun(projects, { sessionId: 'sess-fl', runId: 'wf_1111bbbb-008', agents: wallAgents, agentMtimeMs: Date.now() });
    const ledger = ledgerFile();
    check('agents written in the last 5 minutes: silent (the resume may be running)', silentOk(fire({ input: { session_id: 'sess-fl', transcript_path: f.transcriptPath }, ledger })));
    for (const a of wallAgents) {
        const old = Date.now() - 3600 * 1000;
        fs.utimesSync(path.join(f.runDir, 'agent-' + a.id + '.jsonl'), new Date(old), new Date(old));
    }
    check('once the transcripts are quiet: speaks', !!spoke(fire({ input: { session_id: 'sess-fl', transcript_path: f.transcriptPath }, ledger })));

    // An older wall run beneath a newer journaled one: the latest is what counts.
    const projects2 = tmp('wall-latest-');
    const oldRun = makeRun(projects2, { sessionId: 'sess-la', runId: 'wf_2222cccc-009', agents: wallAgents });
    const newRun = makeRun(projects2, { sessionId: 'sess-la', runId: 'wf_3333dddd-010', agents: [{ id: 'a5000000000000001', journaled: true, secs: 10 }] });
    const earlier = Date.now() - 7200 * 1000;
    fs.utimesSync(path.join(oldRun.runDir, 'journal.jsonl'), new Date(earlier), new Date(earlier));
    const later = Date.now() - 60 * 1000;
    fs.utimesSync(path.join(newRun.runDir, 'journal.jsonl'), new Date(later), new Date(later));
    check('latest run journaled, an older one walled: silent (latest only)', silentOk(fire({ input: { session_id: 'sess-la', transcript_path: oldRun.transcriptPath }, ledger: ledgerFile() })));

    check('AUTODEV_WORKFLOW_WALL=off: silent even on a wall run', silentOk(fire({ input: { session_id: 'sess-fl', transcript_path: f.transcriptPath }, ledger: ledgerFile(), env: { AUTODEV_WORKFLOW_WALL: 'off' } })));
}

// --- --help returns ------------------------------------------------------------
{
    const r = spawnSync(process.execPath, [HOOK, '--help'], { encoding: 'utf8' });
    check('--help prints usage and exits 0', r.status === 0 && /Stop hook/.test(r.stdout));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
