#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/workflow-run-triage.js.
//
// Drives the script as a SUBPROCESS over fixture run directories built by
// tooling/fixtures/workflow-runs.js, which copies the on-disk shapes read from
// a real run on 2026-09-08. Every assertion is about what the script PRINTS or
// RETURNS from the module API, because the hook that consumes it reads those
// and nothing else.
//
// The cases that matter most are the negative-space ones: an unreadable run
// must print COULD NOT CHECK and never "0 lost"; a synthetic row stripped from
// a fixture must move the agent out of lost-quota-wall (the control that the
// marker, and not something else in the fixture, is what classifies).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeRun, WALL_TEXT } = require('./fixtures/workflow-runs.js');

const SCRIPT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'workflow-run-triage.js');
const triage = require(SCRIPT);

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
    if (ok) { pass++; console.log('PASS  ' + name); }
    else { fail++; console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
};

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wftriage-')); }

function run(args, projects) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args, '--projects', projects], { encoding: 'utf8' });
    return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

// --- 1. a fully journaled run ---------------------------------------------
{
    const projects = tmp();
    const f = makeRun(projects, { runId: 'wf_aaaa1111-001', agents: [
        { id: 'a1000000000000001', journaled: true, secs: 120, tools: 5 },
        { id: 'a1000000000000002', journaled: true, secs: 60, tools: 2 },
    ] });
    const r = run(['wf_aaaa1111-001'], projects);
    check('journaled run: exit 0', r.status === 0, 'exit ' + r.status + ' ' + r.err);
    check('journaled run: both agents read as journaled', (r.out.match(/journaled /g) || []).length >= 2, r.out);
    check('journaled run: no resume call printed', !/resumeFromRunId/.test(r.out), r.out);
    check('journaled run: population line names what was scanned', /POPULATION: 1 run directories under 1 project directories/.test(r.out), r.out);
    check('journaled run: tool count ignores a tool_result that quotes a tool_use', /a1000000\s+journaled\s+120 s\s+5 tools/.test(r.out), r.out);
    check('journaled run: unreadable directory list is empty', !/COULD NOT CHECK/.test(r.out), r.out);
    void f;
}

// --- 2. a run that lost agents to the quota wall ---------------------------
{
    const projects = tmp();
    const f = makeRun(projects, { runId: 'wf_bbbb2222-002', name: 'geometry', agents: [
        { id: 'a2000000000000001', key: 'v2:k1', journaled: false, marker: 'wall', secs: 46, tools: 12 },
        { id: 'a2000000000000002', key: 'v2:k2', journaled: false, marker: 'wall', secs: 40, tools: 12 },
        { id: 'a2000000000000003', key: 'v2:k3', journaled: true, secs: 2000, tools: 100 },
    ] });
    const r = run(['wf_bbbb2222-002'], projects);
    check('wall run: exit 1', r.status === 1, 'exit ' + r.status + ' ' + r.err);
    check('wall run: the walled agents are lost-quota-wall', (r.out.match(/lost-quota-wall/g) || []).length === 2, r.out);
    check('wall run: the wall text is quoted', r.out.includes(WALL_TEXT.slice(0, 30)), r.out);
    check('wall run: lost agent-seconds are summed (46+40)', /lost: 86 agent-s, 24 tool calls/.test(r.out), r.out);
    check('wall run: resume re-runs only the keys with no result (2 of 3, 1 cached)', /resume re-runs the 2 of 3 agent call\(s\) with no result \(1 cached, 2,000 agent-s kept\)/.test(r.out), r.out);
    check('wall run: the resume call names the script file and the run id', r.out.includes(`Workflow({scriptPath: ${JSON.stringify(f.scriptPath)}, resumeFromRunId: "wf_bbbb2222-002"})`), r.out);
    check('wall run: RESUME totals line counts the run as recoverable', /RESUME: 1 of 1 lost run\(s\) still have their script file/.test(r.out), r.out);

    // CONTROL: strip the synthetic row from one walled agent; it must stop being a wall loss.
    const file = path.join(f.runDir, 'agent-a2000000000000001.jsonl');
    const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.includes('<synthetic>'));
    fs.writeFileSync(file, kept.join('\n') + '\n');
    const r2 = run(['wf_bbbb2222-002'], projects);
    check('control: without the synthetic row the agent is lost-other, not lost-quota-wall', (r2.out.match(/lost-quota-wall/g) || []).length === 1 && /a2000000\s+lost-other/.test(r2.out), r2.out);

    // The JSON shape the hook consumes.
    const j = JSON.parse(run(['wf_bbbb2222-002', '--json'], projects).out);
    check('json: totals carry the split by cause', j.totals.lostQuotaWall === 1 && j.totals.lostOther === 1 && j.totals.journaled === 1, JSON.stringify(j.totals));
    check('json: the run carries its resume command', j.runs[0].resume && /resumeFromRunId/.test(j.runs[0].resume.command), JSON.stringify(j.runs[0].resume));
}

// --- 3. lost for other reasons: interrupt, api error, no marker, no transcript
{
    const projects = tmp();
    makeRun(projects, { runId: 'wf_cccc3333-003', agents: [
        { id: 'a3000000000000001', journaled: false, marker: 'interrupt', secs: 2305, tools: 127 },
        { id: 'a3000000000000002', journaled: false, marker: 'api', secs: 30, tools: 3 },
        { id: 'a3000000000000003', journaled: false, marker: null, secs: 300, tools: 20 },
        { id: 'a3000000000000004', journaled: false, missingTranscript: true },
    ] });
    const r = run(['wf_cccc3333-003'], projects);
    check('other losses: user interrupt is lost-interrupted', /a3000000\s+lost-interrupted\s+2305 s/.test(r.out), r.out);
    check('other losses: a non-limit synthetic row is lost-api-error', /lost-api-error/.test(r.out), r.out);
    check('other losses: no marker is lost-other', /lost-other\s+300 s/.test(r.out), r.out);
    check('other losses: a started agent with no transcript is counted, not dropped', /no transcript on disk/.test(r.out) && /4 lost/.test(r.out), r.out);
    check('other losses: none of it is a quota wall', /\(0 quota-wall, 1 interrupted, 1 api-error, 2 other\)/.test(r.out), r.out);
}

// --- 4. unreadable: a run "directory" that is a plain file, and a missing journal
{
    const projects = tmp();
    const f = makeRun(projects, { runId: 'wf_dddd4444-004', agents: [{ id: 'a4000000000000001', journaled: true, secs: 10 }] });
    const wd = path.dirname(f.runDir);
    fs.writeFileSync(path.join(wd, 'wf_eeee5555-005'), 'not a directory');
    const r = run(['wf_eeee5555-005'], projects);
    check('unreadable run: prints COULD NOT CHECK', /wf_eeee5555-005\s+COULD NOT CHECK/.test(r.out) && /run directory unreadable/.test(r.out), r.out);
    check('unreadable run: never reports it as 0 lost', !/wf_eeee5555-005.*0 lost/.test(r.out), r.out);
    check('unreadable run: exit 2 when nothing could be read', r.status === 2, 'exit ' + r.status);

    const rAll = run(['--all'], projects);
    check('unreadable among readable: counted separately in the TRIAGED line', /TRIAGED: 1 run\(s\) read, 1 COULD NOT CHECK/.test(rAll.out), rAll.out);

    const g = makeRun(projects, { runId: 'wf_ffff6666-006', withJournal: false, agents: [{ id: 'a6000000000000001', journaled: false, marker: 'wall', secs: 20, tools: 1 }] });
    const r3 = run([g.runDir], projects);
    check('missing journal: COULD NOT CHECK names the journal', /journal\.jsonl unreadable: ENOENT/.test(r3.out), r3.out);
    check('missing journal: the agent is still classified from its transcript', /lost-quota-wall/.test(r3.out), r3.out);
    check('a run directory path is accepted as the target', /wf_ffff6666-006/.test(r3.out), r3.out);
}

// --- 5. --latest, --all-since, and an unknown id -----------------------------
{
    const projects = tmp();
    const old = makeRun(projects, { runId: 'wf_1111aaaa-011', sessionId: 'sess-a', startMs: Date.parse('2026-08-18T10:00:00Z'), agents: [{ id: 'a7000000000000001', journaled: true, secs: 10 }] });
    const newer = makeRun(projects, { runId: 'wf_2222bbbb-022', sessionId: 'sess-b', startMs: Date.parse('2026-09-01T10:00:00Z'), agents: [{ id: 'a8000000000000001', journaled: false, marker: 'wall', secs: 5, tools: 1 }] });
    // The newer run's journal must be newer on disk too.
    const later = Date.now() - 60 * 1000;
    fs.utimesSync(path.join(newer.runDir, 'journal.jsonl'), new Date(later), new Date(later));
    const earlier = Date.now() - 7200 * 1000;
    fs.utimesSync(path.join(old.runDir, 'journal.jsonl'), new Date(earlier), new Date(earlier));

    const latest = run(['--latest'], projects);
    check('--latest picks the run with the newest journal', /wf_2222bbbb-022/.test(latest.out) && !/wf_1111aaaa-011/.test(latest.out), latest.out);

    const since = run(['--all-since', '2026-08-25'], projects);
    check('--all-since keeps runs active on/after the date and says how many it excluded', /wf_2222bbbb-022/.test(since.out) && !/wf_1111aaaa-011  /.test(since.out) && /WINDOW: 1 run\(s\).*1 earlier run\(s\) excluded/.test(since.out), since.out);

    const empty = run(['--all-since', '2027-01-01'], projects);
    check('--all-since with nothing in the window is an answer: exit 0, WINDOW: 0', empty.status === 0 && /WINDOW: 0 run\(s\)/.test(empty.out), 'exit ' + empty.status + ' ' + empty.out);

    const bad = run(['--all-since', 'yesterday'], projects);
    check('--all-since with an unparseable date: exit 2', bad.status === 2, 'exit ' + bad.status);

    const unknown = run(['wf_nope'], projects);
    check('unknown id: COULD NOT CHECK, exit 2', unknown.status === 2 && /COULD NOT CHECK: wf_nope: no run directory/.test(unknown.out), unknown.out);

    const nothing = run(['--all'], path.join(projects, 'absent'));
    check('missing projects dir: COULD NOT CHECK, exit 2', nothing.status === 2 && /COULD NOT CHECK/.test(nothing.out), nothing.out + nothing.err);
}

// --- 6. the module API the hook uses -----------------------------------------
{
    const projects = tmp();
    const f = makeRun(projects, { runId: 'wf_3333cccc-033', sessionId: 'sess-m', agents: [
        { id: 'a9000000000000001', key: 'v2:x', journaled: false, marker: 'wall', secs: 50, tools: 4 },
        { id: 'a9000000000000002', key: 'v2:y', journaled: true, secs: 500, tools: 40 },
    ] });
    const dirs = triage.sessionRunDirs(f.transcriptPath, 'sess-m');
    check('sessionRunDirs finds the run from transcript_path + session_id', dirs.length === 1 && dirs[0].id === 'wf_3333cccc-033', JSON.stringify(dirs));
    check('sessionRunDirs of a session with no runs is empty, not a throw', triage.sessionRunDirs(f.transcriptPath, 'no-such').length === 0);
    const t = triage.triageRun(dirs[0], { now: Date.now() });
    check('triageRun: ok, one wall loss, keys 1 of 2 to re-run', t.ok && t.counts.lostQuotaWall === 1 && t.keys.rerun === 1 && t.keys.started === 2, JSON.stringify(t.counts) + JSON.stringify(t.keys));
    check('triageRun: not in flight when transcripts are an hour old', t.inFlight === false);
    const fresh = Date.now();
    fs.utimesSync(path.join(f.runDir, 'agent-a9000000000000001.jsonl'), new Date(fresh), new Date(fresh));
    check('triageRun: in flight when an agent wrote in the last 5 minutes', triage.triageRun(dirs[0]).inFlight === true);
    check('triageRun: shape is derived from timestamps (two sequential agents = serial)', t.shape.shape === 'serial', JSON.stringify(t.shape));
    check('triageRun on an unreadable path: ok=false with a reason, no throw', (() => { const u = triage.triageRun(path.join(projects, 'absent')); return u.ok === false && u.couldNotCheck.length === 1; })());
}

// --- 7. --help returns, and no positional arguments is usage rather than a scan
{
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    check('--help prints usage and exits 0', r.status === 0 && /Usage:/.test(r.stdout), r.stdout.slice(0, 200));
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    check('no arguments: usage, exit 2', none.status === 2 && /Usage:/.test(none.stdout));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
