#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/usage-mine.js and evals/usage/run.js.
//
// The expensive failures of a usage index are silent ones: a class that never
// matches the real field (so every week reads zero), a report that prints a
// ranking over zero files, a re-mine that double counts a session, and a row
// that carries transcript text into a file someone later copies. Each is
// pinned here by a fixture written by hand, never derived from the extractor's
// own vocabulary, so narrowing a pattern cannot narrow its guard.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'usage-mine.js');
const RUNNER = path.join(__dirname, '..', 'evals', 'usage', 'run.js');
const CHECKS = path.join(__dirname, '..', 'evals', 'usage', 'checks');

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`); }
}

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mine-')));
const home = path.join(scratch, 'home');
const root = path.join(home, '.claude', 'projects');
const out = path.join(home, '.claude', 'autodev', 'usage');
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.CLAUDE_CONFIG_DIR;
const cli = (args, file = SUBJECT) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });

const cfg = path.join(home, '.claude').replace(/\\/g, '/');
// A key-shaped value built at run time, so no scanner reads a literal key in this file.
const SECRET = ['sk', 'ant', 'api03', 'SUITECANARY' + 'Zq7'.repeat(12)].join('-');
const line = (o) => JSON.stringify(o);
function session(dir, id, lines) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, `${id}.jsonl`), lines.map(line).join('\n') + '\n');
}
const asst = (ts, id, blocks) => ({ type: 'assistant', timestamp: ts, sessionId: 'aaaa1111', cwd: 'C:/code/proj-a', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20 }, content: blocks } });
const result = (ts, id, isErr, text, extra = {}) => ({ type: 'user', timestamp: ts, sessionId: 'aaaa1111', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isErr, content: text }] }, ...extra });

try {
    // A worker session: the dontAsk refusal into the config dir, in week 45, carrying a secret in its input.
    session('C--code-proj-a', 'aaaa1111-0000-0000-0000-000000000000', [
        { type: 'user', timestamp: '2026-11-05T10:00:00Z', sessionId: 'aaaa1111', cwd: 'C:/code/proj-a/.claude/worktrees/w', message: { content: 'Brief: report with a BLOCKER: line and a RESULT line.' } },
        { type: 'attachment', timestamp: '2026-11-05T10:00:00Z', attachment: { type: 'hook_success', hookName: 'SessionStart' } },
        asst('2026-11-05T10:00:01Z', 'm1', [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: `${cfg}/autodev/reports/w/REPORT.md`, content: `token ${SECRET}` } }]),
        result('2026-11-05T10:00:02Z', 't1', true, `Permission to use Write has been denied because Claude Code is running in don't ask mode. ${SECRET}`,
            { permissionDecision: { decision: 'reject', source: 'config', reasonType: 'mode', reasonCode: 'mode:dontAsk' } }),
        asst('2026-11-05T10:00:03Z', 'm2', [{ type: 'text', text: 'done' }]),
    ]);
    // An interactive session two weeks earlier: a red gate rerun to green, and a human correction.
    session('C--code-proj-b', 'bbbb2222-0000-0000-0000-000000000000', [
        { type: 'user', timestamp: '2026-10-22T09:00:00Z', sessionId: 'bbbb2222', cwd: 'C:/code/proj-b', origin: { kind: 'human' }, message: { content: 'Fix the parser' } },
        asst('2026-10-22T09:00:01Z', 'n1', [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'npm test' } }]),
        result('2026-10-22T09:00:02Z', 'u1', true, 'Exit code 1\nError: parse failed'),
        { type: 'user', timestamp: '2026-10-22T09:01:00Z', sessionId: 'bbbb2222', origin: { kind: 'human' }, message: { content: 'no, that is the wrong file' } },
        asst('2026-10-22T09:01:01Z', 'n2', [{ type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'npm test' } }]),
        result('2026-10-22T09:01:02Z', 'u2', false, 'all passed'),
    ]);
    fs.mkdirSync(path.join(root, 'C--code-proj-b', 'bbbb2222-0000-0000-0000-000000000000', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'C--code-proj-b', 'bbbb2222-0000-0000-0000-000000000000', 'subagents', 'agent-1.jsonl'),
        [asst('2026-10-22T09:00:05Z', 's1', [{ type: 'tool_use', id: 'v1', name: 'Edit', input: { file_path: 'x' } }]), result('2026-10-22T09:00:06Z', 'v1', true, 'File has not been read yet. Read it first before writing to it.')].map(line).join('\n') + '\n');

    // ---------------------------------------------------------------- selftest, through the exit code
    const st = cli(['--selftest']);
    check('the shipped selftest runs and exits 0', st.status === 0 && /passed, 0 failed/.test(st.stdout), st.stdout.slice(-300));
    check('--help returns at once', cli(['--help']).status === 0);

    // ---------------------------------------------------------------- report before any mine
    const empty = cli(['report', '--out', out]);
    check('a report over an index that mined nothing exits 2, never a clean ranking', empty.status === 2, `${empty.status} ${empty.stderr.slice(0, 200)}`);

    // ---------------------------------------------------------------- mine
    const m1 = cli(['mine', '--root', root, '--out', out]);
    check('mine reads all three files, subagents included', m1.status === 0 && /mined 3 of 3 changed files/.test(m1.stdout), m1.stdout);
    const events = () => fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ev1 = events();
    const cls = ev1.map((e) => e.c).sort();
    check('the dontAsk write is permission-denied/mode:dontAsk aimed at config-dir', ev1.some((e) => e.c === 'permission-denied/mode:dontAsk' && e.tg === 'config-dir' && e.t === 'Write'), cls.join(','));
    check('the red npm test is one gate-red with one rerun', ev1.filter((e) => e.c === 'gate-red').length === 1 && ev1.find((e) => e.c === 'gate-red').r === 1, cls.join(','));
    check('the human overrule is one user-correction', ev1.filter((e) => e.c === 'user-correction').length === 1, cls.join(','));
    check('the subagent Edit refusal is tool-error/edit-before-read, flagged as a subagent', ev1.some((e) => e.c === 'tool-error/edit-before-read' && e.sa === 1), cls.join(','));
    check('the BLOCKER session that never wrote one is no-blocker-line', ev1.some((e) => e.c === 'no-blocker-line' && e.p === 'proj-a'), cls.join(','));
    const raw = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8') + fs.readFileSync(path.join(out, 'sessions.jsonl'), 'utf8');
    check('PRIVACY: no secret, path or transcript text reaches the index', !raw.includes('SUITECANARY') && !raw.includes(SECRET) && !raw.includes('REPORT.md') && !raw.includes('parse failed') && !raw.includes('wrong file') && !/[A-Za-z]:[\\/]/.test(raw));
    check('  control: the canary is in the fixture, so its absence above is the filter working', fs.readFileSync(path.join(root, 'C--code-proj-a', 'aaaa1111-0000-0000-0000-000000000000.jsonl'), 'utf8').includes('SUITECANARY'));

    // ---------------------------------------------------------------- incremental
    const m2 = cli(['mine', '--root', root, '--out', out]);
    check('a second mine with nothing changed mines nothing and keeps every row', /mined 0 of 0 changed/.test(m2.stdout) && events().length === ev1.length, m2.stdout);
    const fa = path.join(root, 'C--code-proj-a', 'aaaa1111-0000-0000-0000-000000000000.jsonl');
    fs.appendFileSync(fa, line({ type: 'attachment', timestamp: '2026-11-05T10:05:00Z', attachment: { type: 'max_turns_reached' } }) + '\n');
    const m3 = cli(['mine', '--root', root, '--out', out]);
    const ev3 = events();
    check('an appended session is re-mined once, never double counted', /mined 1 of 1 changed/.test(m3.stdout) && ev3.length === ev1.length + 1
        && ev3.filter((e) => e.c === 'permission-denied/mode:dontAsk').length === 1, `${m3.stdout} ${ev3.length} vs ${ev1.length}`);
    fs.rmSync(path.join(root, 'C--code-proj-b'), { recursive: true });
    cli(['mine', '--root', root, '--out', out]);
    check('a transcript removed by cleanup keeps its history rows', events().some((e) => e.c === 'gate-red'));

    // ---------------------------------------------------------------- report
    const rj = cli(['report', '--out', out, '--json', '--weeks', '4']);
    let r = null;
    try { r = JSON.parse(rj.stdout); } catch { /* reported below */ }
    const row = (c) => r && r.byCount.find((x) => x.class === c);
    check('report --json exits 0 and names its population', rj.status === 0 && r && r.population.filesMined === 3 && r.population.events === ev3.length, rj.stdout.slice(0, 200));
    // The fixture dates are fixed and the window ends this week, so the window is pinned to the fixture's own last week.
    const pinned = require(SUBJECT).report({ out, weeks: 4, now: Date.parse('2026-11-05T12:00:00Z') });
    const pinnedRow = (c) => pinned.byCount.find((x) => x.class === c);
    check('a class is counted in the week it happened', pinnedRow('gate-red') && pinnedRow('gate-red').weekly.join(',') === '0,1,0,0' && pinnedRow('permission-denied/mode:dontAsk').weekly.join(',') === '0,0,0,1',
        JSON.stringify(pinned.population.weeks));
    check('cost carries tokens and retries', row('gate-red') && row('gate-red').tok > 0 && row('gate-red').retries === 1, JSON.stringify(row('gate-red')));
    check('--class narrows the ranking by prefix', JSON.parse(cli(['report', '--out', out, '--json', '--class', 'gate-']).stdout).byCount.every((x) => x.class.startsWith('gate-')));
    const human = cli(['report', '--out', out]);
    check('the human report prints the population line first', /^usage-mine report/.test(human.stdout) && /3 transcript files mined/.test(human.stdout), human.stdout.slice(0, 300));

    // ---------------------------------------------------------------- observe
    const ob = cli(['observe', '--root', root, '--out', out]);
    check('observe mines, writes report-latest.json and one history row, and exits 0', ob.status === 0 && fs.existsSync(path.join(out, 'report-latest.json'))
        && fs.readFileSync(path.join(out, 'history.jsonl'), 'utf8').trim().split('\n').length === 1, ob.stdout + ob.stderr);
    check('observe with a missing root exits 2', cli(['observe', '--root', path.join(scratch, 'nope'), '--out', out]).status === 2);

    // ---------------------------------------------------------------- extract on a stream-json log
    const log = path.join(scratch, 'worker.log');
    fs.writeFileSync(log, [
        { type: 'system', subtype: 'init', cwd: 'C:/code/proj-a', permissionMode: 'dontAsk', model: 'claude-opus-5-5', session_id: 'cccc3333' },
        asst('2026-11-05T11:00:00Z', 'w1', [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: `cat > "${cfg}/autodev/reports/w/REPORT.md" <<'EOF'` } }]),
        result('2026-11-05T11:00:01Z', 'x1', true, "Permission to use Bash has been denied because Claude Code is running in don't ask mode."),
        { type: 'result', subtype: 'success', permission_denials: [{ tool_name: 'Bash', tool_use_id: 'x1', tool_input: {} }] },
    ].map(line).join('\n') + '\nnot json\n');
    const ex = cli(['extract', '--log', log, '--json']);
    let xr = null;
    try { xr = JSON.parse(ex.stdout); } catch { /* reported below */ }
    check('extract reads a stream-json log: one dontAsk denial into the config dir, not two', xr && xr.events.length === 1 && xr.events[0].c === 'permission-denied/mode:dontAsk' && xr.events[0].tg === 'config-dir',
        ex.stdout.slice(0, 300));

    // ---------------------------------------------------------------- evals/usage
    const list = cli(['--list'], RUNNER);
    check('run.js --list names at least ten cases', list.status === 0 && list.stdout.trim().split('\n').length >= 10, list.stdout);
    const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'usage', 'cases.json'), 'utf8')).cases;
    check('every case has a class, evidence, a paraphrased prompt and a checker that exists', cases.every((c) => c.class && c.evidence && typeof c.evidence.events === 'number'
        && typeof c.prompt === 'string' && c.prompt.length > 20 && (c.kind === 'replay' ? c.replay && c.replay.doneMarker : fs.existsSync(path.join(CHECKS, path.basename(c.checker))))));
    const harness = cli([], RUNNER);
    check('every harness case is green on this tree', harness.status === 0, harness.stdout.slice(-600));
    const bad = cli(['--expect-red', 'no-such-case'], RUNNER);
    check('--expect-red naming no case is could-not-run, exit 2', bad.status === 2, bad.stdout.slice(-200));
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
