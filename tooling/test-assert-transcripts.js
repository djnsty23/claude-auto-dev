#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/assert-transcripts.js.
//
// The tool asserts worker rules over real session transcripts, so every case
// here is a transcript shaped the way the CLI writes one: tool calls in an
// assistant message's content[], their results in the next user message, the
// event time at the top level.
//
// Acceptance, named before the tool was written:
//   A1  an edit followed by a commit with no check in between is reported
//   A2  an edit, a check, then a commit is clean
//   A3  "#N merged" with no earlier probe of N is reported, and clean with one
//   A4  --no-verify, a force push and reset --hard are reported when they ran,
//       and not when the hook refused them
//   A5  the population is printed, and an empty root exits 2, not 0
//   A6  --selftest derives its negatives from the subject population, writes
//       them apart from it, and refuses (exit 2) when no positive control exists

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'assert-transcripts.js');
const lib = require(TOOL);
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
    if (ok) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); }
};

let clock = Date.now() - 3600_000;
const ts = () => new Date(clock += 1000).toISOString();
let nextId = 0;

function use(name, input) {
    const id = 'tu' + (++nextId);
    return { id, line: JSON.stringify({ type: 'assistant', timestamp: ts(),
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) };
}
function result(id, { error = false, text = 'ok' } = {}) {
    return JSON.stringify({ type: 'user', timestamp: ts(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: text }] } });
}
// A tool call and its result, as two transcript lines.
function call(name, input, opts) { const u = use(name, input); return [u.line, result(u.id, opts)]; }
const bash = (command, opts) => call('Bash', { command }, opts);
const edit = (file) => call('Edit', { file_path: file, old_string: 'a', new_string: 'b' });
function say(text) {
    return [JSON.stringify({ type: 'assistant', timestamp: ts(),
        message: { role: 'assistant', content: [{ type: 'text', text }] } })];
}

function fixture(sessions) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asserttx-'));
    const proj = path.join(root, 'C--Users-x-code-demo');
    fs.mkdirSync(proj, { recursive: true });
    sessions.forEach((lines, i) => {
        fs.writeFileSync(path.join(proj, `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444.jsonl`),
            lines.flat().join('\n') + '\n');
    });
    return root;
}
function run(root, extra = []) {
    const r = spawnSync(process.execPath, [TOOL, '--root', root, '--days', '2', ...extra],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return r;
}
function runJson(root) {
    const r = run(root, ['--json']);
    try { return { r, j: JSON.parse(r.stdout) }; } catch { return { r, j: null }; }
}
const kinds = (j) => (j ? j.findings.map((f) => f.assertion) : []);

// ── A1 / A2: a commit needs a check after the last edit
{
    const bad = [edit('src/a.ts'), bash('git add src/a.ts && git commit -F msg.txt')];
    const good = [edit('src/a.ts'), bash('npm test'), bash('git add src/a.ts && git commit -F msg.txt')];
    const noEdit = [bash('git commit -F msg.txt')];
    const quoted = [edit('src/a.ts'), bash('grep -n "git commit" docs/x.md')];
    const { j } = runJson(fixture([bad, good, noEdit, quoted]));
    const hits = j ? j.findings.filter((f) => f.assertion === 'commit-without-check') : [];
    check('A1 an edit then a commit with no check is reported', hits.length === 1);
    check('A2 edit, check, commit is clean (one finding across four sessions)', hits.length === 1 && hits[0].session.startsWith('00000000'));
    check('  a commit with no edit before it is counted, not reported', !!j && j.population.commits === 3);
    check('  "git commit" inside a quoted argument is not a commit', !!j && j.population.commits === 3);
}

// ── A1b: only repo edits count, and a check chained before the commit counts
{
    const withCwd = (lines) => lines.flat().map((l) => { const d = JSON.parse(l); d.cwd = 'C:\\repo'; return JSON.stringify(d); });
    const outside = withCwd([call('Write', { file_path: 'C:\\tmp\\msg.txt', content: 'x' }), bash('git commit -F C:/tmp/msg.txt')]);
    const inside = withCwd([edit('C:\\repo\\src\\a.ts'), bash('git commit -F m')]);
    const chained = withCwd([edit('C:\\repo\\src\\b.ts'), bash('npm test && git commit -F m')]);
    const docs = withCwd([edit('C:\\repo\\README.md'), bash('git commit -F m')]);
    const session = withCwd([call('Write', { file_path: 'C:\\repo\\.claude\\msg.txt', content: 'x' }), bash('git commit -F .claude/msg.txt')]);
    const loop = withCwd([edit('C:\\repo\\src\\c.ts'), bash('for t in test-a test-b; do node tooling/$t.js; done'), bash('git commit -F m')]);
    const { j } = runJson(fixture([outside, inside, chained, docs, session, loop]));
    const hits = j ? j.findings.filter((f) => f.assertion === 'commit-without-check') : [];
    check('A1b an edit outside the session cwd does not make a commit unchecked', !hits.some((h) => h.session.startsWith('00000000')));
    check('  an edit inside it does', hits.some((h) => h.session.startsWith('00000001') && h.detail.includes('a code')));
    check('  `npm test && git commit` is clean', !hits.some((h) => h.session.startsWith('00000002')));
    check('  a docs-only edit is labelled so', hits.some((h) => h.session.startsWith('00000003') && h.detail.includes('docs-only')));
    check('  a commit message in <repo>/.claude/ is not repo work', !hits.some((h) => h.session.startsWith('00000004')));
    check('  a `for t in test-a ...` loop is a check', !hits.some((h) => h.session.startsWith('00000005')));
}

// ── A3: a merged claim needs a probe of that PR first
{
    const bare = [say('Done: #412 merged and deployed.')];
    const probed = [bash('gh pr view 413 --json state'), say('#413 merged.')];
    const negated = [say('#414 is not merged yet.')];
    const relayed = [...call('Bash', { command: 'node merge-lock.js merge --pr 415' }, { text: 'merged #415 as abc' }), say('PR #415 merged.')];
    const { j } = runJson(fixture([bare, probed, negated, relayed]));
    const hits = j ? j.findings.filter((f) => f.assertion === 'merged-claim-unverified') : [];
    check('A3 "#412 merged" with no probe is reported', hits.length === 1 && hits[0].detail.includes('#412'));
    check('  a claim after `gh pr view 413` is clean', !hits.some((h) => h.detail.includes('#413')));
    check('  "not merged yet" is not a claim', !!j && j.population.mergedClaims === 3);
    check('  a claim after merge-lock printed the merge is clean', !hits.some((h) => h.detail.includes('#415')));
}

// ── A4: forbidden git that ran, not git the hook refused
{
    const ran = [bash('git commit --no-verify -F m.txt'), bash('git push --force origin x'), bash('git reset --hard HEAD~1')];
    const refused = [bash('git push -f origin y', { error: true, text: 'Blocked: force push' })];
    const fine = [bash('git push -u origin z'), bash('git reset --soft HEAD~1')];
    const { j } = runJson(fixture([ran, refused, fine]));
    const hits = j ? j.findings.filter((f) => f.assertion === 'forbidden-git') : [];
    check('A4 --no-verify, --force and reset --hard are reported', hits.length === 3);
    check('  a refused force push is not a finding', !hits.some((h) => h.session.startsWith('00000001')));
    check('  push -u and reset --soft are not findings', !hits.some((h) => h.session.startsWith('00000002')));
    check('  findings print the flag, never the whole command', hits.every((h) => !h.detail.includes('origin')));
}

// ── A5: population line, and an empty root is indeterminate
{
    const r = run(fixture([[edit('a'), bash('npm test'), bash('git commit -F m')]]));
    check('A5 the population line is printed', /POPULATION: 1 transcript/.test(r.stdout), r.stdout.slice(0, 200));
    check('  a clean population exits 0', r.status === 0, `exit ${r.status}`);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'asserttx-empty-'));
    const e = run(empty);
    check('  an empty root exits 2', e.status === 2, `exit ${e.status}`);
    const s = run(fixture([[edit('a'), bash('git commit -F m')]]), ['--strict']);
    check('  --strict exits 1 on a finding', s.status === 1, `exit ${s.status}`);
}

// ── A6: the selftest derives its negatives from the subject
{
    const root = fixture([
        [edit('a.ts'), bash('npm run gate:fast'), bash('git commit -F m')],
        [bash('gh pr view 77'), say('#77 merged.')],
    ]);
    const before = fs.readdirSync(path.join(root, 'C--Users-x-code-demo')).sort().join(',');
    const r = run(root, ['--selftest']);
    check('A6 the selftest passes on a population with positive controls', r.status === 0, r.stdout + r.stderr);
    check('  it names the sessions it derived from', /derived from 00000000/.test(r.stdout) && /derived from 00000001/.test(r.stdout));
    const after = fs.readdirSync(path.join(root, 'C--Users-x-code-demo')).sort().join(',');
    check('  it writes nothing into the subject root', before === after);
    const none = fixture([[say('hello')]]);
    const n = run(none, ['--selftest']);
    check('  no positive control in the population exits 2', n.status === 2, `exit ${n.status}`);
}

// ── Unit: the command helpers the assertions rest on
{
    check('stripQuotes empties quoted text', lib.stripQuotes('grep "git commit" x') === 'grep "" x');
    check('isCommit sees git -C dir commit', lib.isCommit('git -C repo commit -F m'));
    check('isCheck sees npm run gate:fast and node tooling/test-x.js',
        lib.isCheck('npm run gate:fast') && lib.isCheck('node tooling/test-x.js') && !lib.isCheck('npm install'));
    check('forbiddenFlag names the flag', lib.forbiddenFlag('git push -f o b') === 'push --force'
        && lib.forbiddenFlag('git status') === null);
    check('  --force-with-lease is not a forbidden force push', lib.forbiddenFlag('git push --force-with-lease=b:abc o b') === null);
    check('  a heredoc body that mentions --no-verify is data',
        lib.forbiddenFlag("cat > b.md <<'EOF'\nNever git commit --no-verify.\nEOF\ngit status") === null
        && lib.forbiddenFlag("cat > b.md <<'EOF'\nx\nEOF\ngit commit --no-verify -F m") === '--no-verify');
    check('mergedClaims skips negations', lib.mergedClaims('#5 merged, #6 not merged').join() === '5');
    check('  and conditionals before the number', lib.mergedClaims('When the Brain confirms #733 has merged, go.').length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
