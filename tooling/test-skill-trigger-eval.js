#!/usr/bin/env node
// Acceptance tests for skill-trigger-eval.js.
//
// The live run needs a model and is not exercised here. What is: the guard
// that keeps a held-out prompt from executing anything (the hook, as the CLI
// spawns it), the before-arm builder (an empty archive would grade every
// skill 0 and read as a regression), and the report (a stolen trigger must
// show up against the skill that took it, not vanish into a miss).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUBJECT = path.join(ROOT, 'tooling', 'skill-trigger-eval.js');

const cases = [];
const check = (label, ok, why) => cases.push([label, ok, why]);
const run = (args, input) => spawnSync(process.execPath, [SUBJECT, ...args], {
    cwd: ROOT, encoding: 'utf8', input, windowsHide: true,
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-skill-trigger-eval-'));
try {
    const help = run(['--help']);
    check('--help returns 0', help.status === 0 && /run --cases/.test(help.stdout), `status=${help.status}`);

    const self = run(['--selftest']);
    check('--selftest passes', self.status === 0 && /0 failed/.test(self.stdout), self.stdout.slice(-300));

    const skill = run(['hook'], JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'ship' } }));
    check('the hook lets Skill run, silently', skill.status === 0 && skill.stdout === '' && skill.stderr === '',
        `status=${skill.status} stdout=${skill.stdout}`);
    for (const tool of ['Bash', 'Write', 'Edit', 'mcp__vistek__offers_send']) {
        const r = run(['hook'], JSON.stringify({ tool_name: tool, tool_input: {} }));
        let decision = null;
        try { decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision; } catch { /* stays null */ }
        check(`the hook denies ${tool}`, r.status === 0 && decision === 'deny', `status=${r.status} stdout=${r.stdout}`);
    }
    const empty = run(['hook'], '');
    check('the hook denies an empty event', /"deny"/.test(empty.stdout), empty.stdout);

    const arch = run(['archive', '--ref', 'HEAD', '--to', path.join(tmp, 'arm')]);
    const archived = path.join(tmp, 'arm', 'plugins', 'autodev-core', 'skills');
    const n = fs.existsSync(archived) ? fs.readdirSync(archived).length : 0;
    const live = fs.readdirSync(path.join(ROOT, 'plugins', 'autodev-core', 'skills')).length;
    check('archive extracts the committed plugin tree', arch.status === 0 && n > 0 && n === live,
        `status=${arch.status} archived=${n} live=${live} ${arch.stderr}`);
    check('  and prints its skill count', /: \d+ skills, digest [0-9a-f]{12}/.test(arch.stdout), arch.stdout);

    const rows = [
        { arm: 'before', id: 'p1', expected: 'prove', sample: 0, hit: true, skills: ['prove'], otherSkills: [], armOk: true },
        { arm: 'after', id: 'p1', expected: 'prove', sample: 0, hit: false, skills: ['ship'], otherSkills: [], armOk: true },
        { arm: 'after', id: 'p1', expected: 'prove', sample: 1, hit: false, skills: [], otherSkills: ['web-analytics'], armOk: true },
        { arm: 'after', id: 'p1', expected: 'prove', sample: 2, hit: true, skills: ['prove'], otherSkills: [], armOk: false, armWhy: 'x' },
    ];
    const fixture = path.join(tmp, 'rows.jsonl');
    fs.writeFileSync(fixture, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const rep = run(['report', fixture]);
    check('report exits 0 on rows', rep.status === 0, `status=${rep.status} ${rep.stderr}`);
    check('  prints its population and the exclusion', /population: 4 run\(s\), 1 excluded/.test(rep.stdout), rep.stdout.slice(0, 200));
    check('  rates per arm', /\| prove \| 1\/1 \| 0\/2 \|/.test(rep.stdout), rep.stdout);
    check('  names the skill that stole the trigger', /\| prove \| 1\/1 \| 0\/2 \| - \/ ship 1 \|/.test(rep.stdout), rep.stdout);
    check('  separates a non-autodev skill from nothing', /\(other\) 1/.test(rep.stdout), rep.stdout);
    const none = run(['report', path.join(tmp, 'absent.jsonl')]);
    check('report on no rows exits 1', none.status === 1, `status=${none.status}`);

    // --base: 1/1 against 0/2 is a drop but noise, so exit 0 and say so. A
    // 6/6 against 0/6 drop is significant and exits 3.
    const noise = run(['report', fixture, '--base', 'before']);
    check('--base lists a drop at small n without failing', noise.status === 0
        && /Below base arm before .*prove in after 0\/2 vs 1\/1, p=0\.333(?! SIGNIFICANT)/.test(noise.stdout), `status=${noise.status} ${noise.stdout}`);
    const big = [];
    for (let i = 0; i < 6; i++) {
        big.push({ arm: 'before', id: 'q', expected: 'ship', sample: i, hit: true, skills: ['ship'], otherSkills: [], armOk: true });
        big.push({ arm: 'after', id: 'q', expected: 'ship', sample: i, hit: false, skills: [], otherSkills: [], armOk: true });
    }
    const bigFile = path.join(tmp, 'big.jsonl');
    fs.writeFileSync(bigFile, big.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const sig = run(['report', bigFile, '--base', 'before']);
    check('--base exits 3 on a significant drop', sig.status === 3 && /ship in after 0\/6 vs 6\/6, p=0\.001 SIGNIFICANT/.test(sig.stdout), `status=${sig.status} ${sig.stdout.slice(-300)}`);
    // The shapes a real headless run ends with: the one-turn cap, and an expired login.
    const { parseStream, runError } = require(SUBJECT);
    const end = (r) => parseStream(JSON.stringify({ type: 'result', ...r }));
    check('the one-turn cap is not an error', runError(end({ subtype: 'error_max_turns', is_error: true }), 1) === false, 'max_turns flagged');
    check('an expired login is an error, so the report drops it', runError(end({ subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired' }), 1) === true, 'auth failure graded as a miss');
    const nobase = run(['report', fixture, '--base', 'nope']);
    check('--base naming an absent arm exits 2', nobase.status === 2, `status=${nobase.status}`);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const [label, ok, why] of cases) {
    if (!ok) failed++;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n     ${why}`}\n`);
}
process.stdout.write(`\n${cases.length - failed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
