#!/usr/bin/env node
// Tests for plugins/autodev-core/hooks/session-env-dedupe.js
// Run: node tooling/test-session-env-dedupe.js
// Exits 1 on any failed assertion.
//
// Every case plants real session-env growth in a temp dir and watches the hook
// remove it. The semantic cases SOURCE the files in bash before and after, so
// "bash ends up with the same values" is measured rather than assumed; a
// missing bash fails those cases instead of skipping them.
//
// The hook runs as a subprocess, because that is how the harness runs it and
// because the property that matters most cannot be tested any other way: it
// must emit ZERO BYTES on stdout AND stderr. Both streams are checked on every
// hook-mode case.
//
// The child's env is scrubbed of CLAUDE_ENV_FILE and CLAUDE_PLUGIN_DATA. Run
// from a Claude session's Bash tool, this process inherits whatever the env
// files export, and the codex plugin exports ITS OWN plugin data dir under that
// second name: an unscrubbed run would log into another plugin's directory.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'session-env-dedupe.js');
const HOOKS_JSON = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'hooks.json');
const { plan, replaceIfUnchanged, hookDir } = require(HOOK);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-env-dedupe-'));
const CONFIG = path.join(TMP, 'config');
const DATA = path.join(TMP, 'plugin-data');
const BASH = findBash();
// Values shaped like the codex plugin's: a session id, a path, and a single
// quote escaped the way its shellEscape does.
const CODEX_BLOCK = [
    "export CODEX_COMPANION_SESSION_ID='0f3c9a4e-1111-2222-3333-444455556666'",
    "export CODEX_COMPANION_TRANSCRIPT_PATH='C:\\Users\\someone\\.claude\\projects\\x\\0f3c9a4e.jsonl'",
    "export CLAUDE_PLUGIN_DATA='C:\\Users\\someone\\.claude\\plugins\\data\\it'\"'\"'s-codex'",
].join('\n') + '\n';
const CODEX_NAMES = ['CODEX_COMPANION_SESSION_ID', 'CODEX_COMPANION_TRANSCRIPT_PATH', 'CLAUDE_PLUGIN_DATA'];

let failed = 0;
let cases = 0;
function check(name, ok, detail) {
    cases++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + detail}`);
    if (!ok) failed++;
}

// Git for Windows ships its own bash next to git; `bash` on a Windows PATH can
// be WSL's, which sources nothing from a Windows temp path.
function findBash() {
    if (process.platform !== 'win32') return 'bash';
    try {
        const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
        const candidate = path.join(exec, '..', '..', '..', 'bin', 'bash.exe');
        if (fs.existsSync(candidate)) return candidate;
    } catch { /* fall through to the default install locations */ }
    return ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find((p) => fs.existsSync(p)) || 'bash';
}

function sessionDir(name, files, root = TMP) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text, 'utf8');
    return dir;
}

function lineCount(file) {
    const t = fs.readFileSync(file, 'utf8');
    return t === '' ? 0 : t.replace(/\n$/, '').split('\n').length;
}

// What the harness hands bash: every matching file, in its order, trimmed,
// joined by newlines. Written independently of the hook's own ordering code.
function concatenated(dir) {
    const order = { setup: 0, sessionstart: 1, cwdchanged: 2, filechanged: 3 };
    const re = /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/;
    return fs.readdirSync(dir).filter((n) => re.test(n)).sort((a, b) => {
        const ma = a.match(re); const mb = b.match(re);
        return ma[1] !== mb[1] ? order[ma[1]] - order[mb[1]] : Number(ma[2]) - Number(mb[2]);
    }).map((n) => fs.readFileSync(path.join(dir, n), 'utf8').trim()).filter(Boolean).join('\n');
}

// The values bash ends up with after sourcing the script, for the given names.
function bashValues(script, names) {
    const probe = names.map((n) => `printf '%s=[%s]\\n' ${n} "\${${n}-<unset>}"`).join('\n');
    const r = spawnSync(BASH, ['-s'], { input: script + '\n' + probe + '\n', encoding: 'utf8' });
    return (r.stdout || '') + (r.stderr ? 'STDERR:' + r.stderr : '') + (r.error ? 'ERROR:' + r.error.message : '');
}

function childEnv(extra = {}) {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: CONFIG };
    delete env.CLAUDE_ENV_FILE;
    delete env.CLAUDE_PLUGIN_DATA;
    return { ...env, ...extra };
}

function run(args, input, extra) {
    const r = spawnSync(process.execPath, [HOOK, ...args], { input: input || '', encoding: 'utf8', env: childEnv(extra) });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const silent = (r) => r.code === 0 && r.out === '' && r.err === '';

console.log(`session-env-dedupe (bash: ${BASH})`);

// 1. The headline: one file of 69 duplicated lines holds 3 after the guard.
{
    const dir = sessionDir('plant-69', { 'sessionstart-hook-11.sh': CODEX_BLOCK.repeat(23) });
    const file = path.join(dir, 'sessionstart-hook-11.sh');
    const before = bashValues(concatenated(dir), CODEX_NAMES);
    check('planted file holds 69 lines', lineCount(file) === 69, `got ${lineCount(file)}`);
    const r = run(['--dir', dir]);
    check('69 -> 3 lines', lineCount(file) === 3, `got ${lineCount(file)}; out=${r.out}`);
    check('kept lines are the original block', fs.readFileSync(file, 'utf8') === CODEX_BLOCK, 'content differs');
    check('bash sees the same values', bashValues(concatenated(dir), CODEX_NAMES) === before, 'values differ');
    check('before-values really came from bash', before.includes("it's-codex"), before);
    check('no temp file left behind', fs.readdirSync(dir).length === 1, fs.readdirSync(dir).join(','));
    const again = run(['--dir', dir]);
    check('second run changes nothing', /rewrote 0 file/.test(again.out) && lineCount(file) === 3, again.out);
}

// 2. The measured shape: 27 + 42 lines in two files (the index moved between rounds).
{
    const dir = sessionDir('plant-27-42', {
        'sessionstart-hook-10.sh': CODEX_BLOCK.repeat(9),
        'sessionstart-hook-11.sh': CODEX_BLOCK.repeat(14),
    });
    const before = bashValues(concatenated(dir), CODEX_NAMES);
    run(['--dir', dir]);
    const total = lineCount(path.join(dir, 'sessionstart-hook-10.sh')) + lineCount(path.join(dir, 'sessionstart-hook-11.sh'));
    check('27 + 42 -> 3 lines in total', total === 3, `got ${total}`);
    check('the later file keeps them', lineCount(path.join(dir, 'sessionstart-hook-11.sh')) === 3, 'hook-11 lost its lines');
    check('two files: bash sees the same values', bashValues(concatenated(dir), CODEX_NAMES) === before, 'values differ');
}

// 2b. Harness order is not name order: hook-9 runs before hook-10, and setup
//     before sessionstart, though both sort the other way as strings. The copy
//     that survives must be the one bash reads last.
{
    const dir = sessionDir('harness-order', {
        'sessionstart-hook-9.sh': "export A='old'\n",
        'sessionstart-hook-10.sh': "export A='new'\n",
        'setup-hook-0.sh': "export B='first'\n",
        'sessionstart-hook-0.sh': "export B='second'\n",
    });
    const before = bashValues(concatenated(dir), ['A', 'B']);
    run(['--dir', dir]);
    check('harness order: bash still sees A=new and B=second', bashValues(concatenated(dir), ['A', 'B']) === before && before.includes('A=[new]') && before.includes('B=[second]'), before);
    check('harness order: the earlier copies are the ones removed',
        lineCount(path.join(dir, 'sessionstart-hook-9.sh')) === 0 && lineCount(path.join(dir, 'setup-hook-0.sh')) === 0, fs.readdirSync(dir).join(','));
}

// 3. A changed value: the later assignment wins, before and after.
{
    const dir = sessionDir('changed-value', { 'sessionstart-hook-5.sh': "export A='1'\nexport B=x\nexport A='2'\n" });
    const before = bashValues(concatenated(dir), ['A', 'B']);
    run(['--dir', dir]);
    const after = fs.readFileSync(path.join(dir, 'sessionstart-hook-5.sh'), 'utf8');
    check('changed value: only the dead line goes', after === "export B=x\nexport A='2'\n", after);
    check('changed value: bash sees A=2', bashValues(concatenated(dir), ['A', 'B']) === before && before.includes('A=[2]'), before);
}

// 4. A name another line reads is never touched, or B would change.
{
    const text = "export A=1\nexport B=\"$A/bin\"\nexport A=2\nexport C=\"${A}x\"\n";
    const dir = sessionDir('read-reference', { 'sessionstart-hook-5.sh': text });
    run(['--dir', dir]);
    check('a name that is read keeps every assignment', fs.readFileSync(path.join(dir, 'sessionstart-hook-5.sh'), 'utf8') === text, 'file changed');
}

// 5. A multi-line quoted value: the line inside the quote is not an assignment.
{
    const text = "export M='first\nexport A=1\n'\nexport A=2\nexport A=3\n";
    const dir = sessionDir('multi-line', { 'sessionstart-hook-5.sh': text });
    const before = bashValues(concatenated(dir), ['M', 'A']);
    run(['--dir', dir]);
    const after = fs.readFileSync(path.join(dir, 'sessionstart-hook-5.sh'), 'utf8');
    check('multi-line: the quoted line survives', after.includes("export M='first\nexport A=1\n'\n"), after);
    check('multi-line: bash sees the same values', bashValues(concatenated(dir), ['M', 'A']) === before, before);
}

// 6. Lines that are not literal exports stay verbatim, duplicates included.
{
    const text = 'PATH="/x:$PATH"\nPATH="/x:$PATH"\n# note\nsource ./other.sh\nexport D="$HOME"\nexport D="$HOME"\n';
    const dir = sessionDir('opaque', { 'sessionstart-hook-5.sh': text });
    const c = plan([{ name: 'sessionstart-hook-5.sh', text }]);
    check('non-literal lines are never planned away', c.length === 0, JSON.stringify(c));
    run(['--dir', dir]);
    check('non-literal file untouched', fs.readFileSync(path.join(dir, 'sessionstart-hook-5.sh'), 'utf8') === text, 'file changed');
}

// 7. CRLF files keep their line endings.
{
    const dir = sessionDir('crlf', { 'sessionstart-hook-5.sh': 'export A=1\r\nexport A=1\r\n' });
    run(['--dir', dir]);
    const after = fs.readFileSync(path.join(dir, 'sessionstart-hook-5.sh'), 'utf8');
    check('CRLF: one line left, CRLF kept', after === 'export A=1\r\n', JSON.stringify(after));
}

// 8. Hook mode, the way the harness runs it: no arguments, JSON on stdin,
//    silent on both streams, exit 0, log in the PLUGIN's data dir.
{
    const id = 'hook-session-1';
    const dir = sessionDir(id, { 'sessionstart-hook-11.sh': CODEX_BLOCK.repeat(23) }, path.join(CONFIG, 'session-env'));
    const file = path.join(dir, 'sessionstart-hook-11.sh');
    const r = run([], JSON.stringify({ session_id: id, hook_event_name: 'PreCompact' }), { CLAUDE_PLUGIN_DATA: DATA });
    check('hook: 69 -> 3 by session_id', lineCount(file) === 3, `got ${lineCount(file)}`);
    check('hook: zero bytes on stdout and stderr, exit 0', silent(r), JSON.stringify(r));
    const logFile = path.join(DATA, 'session-env-dedupe.log');
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check('hook: logged names and counts', /"event":"PreCompact".*"before":69,"after":3/.test(logText), logText);
    check('hook: log carries no values', logText !== '' && !logText.includes('0f3c9a4e') && !logText.includes('someone'), 'a value reached the log');
    check('hook: nothing written under <config>/logs', !fs.existsSync(path.join(CONFIG, 'logs')), 'the config dir gained a logs dir');
    for (const [label, input] of [
        ['garbage stdin', '{not json'],
        ['hostile id', JSON.stringify({ session_id: '../../x' })],
        ['missing dir', JSON.stringify({ session_id: 'no-such-session' })],
        ['empty stdin', ''],
        ['a JSON array', '[1,2]'],
        ['JSON null', 'null'],
        ['a non-string id', JSON.stringify({ session_id: 42 })],
    ]) {
        const g = run([], input, { CLAUDE_PLUGIN_DATA: DATA });
        check(`hook: ${label} is silent, exit 0`, silent(g), JSON.stringify(g));
    }
}

// 9. With no plugin data dir the hook still works, and logs nowhere at all.
{
    const id = 'hook-no-data';
    const dir = sessionDir(id, { 'sessionstart-hook-3.sh': CODEX_BLOCK.repeat(2) }, path.join(CONFIG, 'session-env'));
    const before = fs.readdirSync(TMP).sort().join(',');
    const r = run([], JSON.stringify({ session_id: id, hook_event_name: 'SessionEnd' }));
    check('no data dir: still 6 -> 3', lineCount(path.join(dir, 'sessionstart-hook-3.sh')) === 3, `got ${lineCount(path.join(dir, 'sessionstart-hook-3.sh'))}`);
    check('no data dir: silent, exit 0', silent(r), JSON.stringify(r));
    check('no data dir: no log file appeared anywhere in the sandbox', fs.readdirSync(TMP).sort().join(',') === before && !fs.existsSync(path.join(CONFIG, 'logs')), fs.readdirSync(TMP).join(','));
}

// 10. CLAUDE_ENV_FILE says where, session_id says which: an env file naming
//     ANOTHER session is ignored, one naming this session is used.
{
    const envRoot = path.join(TMP, 'harness-config', 'session-env');
    const own = sessionDir('env-own', { 'sessionstart-hook-2.sh': CODEX_BLOCK.repeat(2), 'sessionstart-hook-7.sh': '' }, envRoot);
    const other = sessionDir('env-other', { 'sessionstart-hook-2.sh': CODEX_BLOCK.repeat(2), 'sessionstart-hook-7.sh': '' }, envRoot);
    const r1 = run([], JSON.stringify({ session_id: 'env-own', hook_event_name: 'SessionStart' }), { CLAUDE_ENV_FILE: path.join(own, 'sessionstart-hook-7.sh') });
    check('env file for this session: it is the one rewritten', lineCount(path.join(own, 'sessionstart-hook-2.sh')) === 3 && silent(r1), JSON.stringify(r1));
    const r2 = run([], JSON.stringify({ session_id: 'env-own-2', hook_event_name: 'SessionStart' }), { CLAUDE_ENV_FILE: path.join(other, 'sessionstart-hook-7.sh') });
    check('env file for another session: that session is left alone', lineCount(path.join(other, 'sessionstart-hook-2.sh')) === 6 && silent(r2), `got ${lineCount(path.join(other, 'sessionstart-hook-2.sh'))}`);
    const cfg = (env) => env.CLAUDE_CONFIG_DIR;
    check('hookDir: no session_id means no directory', hookDir({}, { CLAUDE_ENV_FILE: path.join(own, 'x.sh') }, cfg) === null, 'a directory was chosen');
    check('hookDir: an env file outside session-env is not trusted',
        hookDir({ session_id: 'env-own' }, { CLAUDE_ENV_FILE: path.join(TMP, 'env-own', 'x.sh'), CLAUDE_CONFIG_DIR: CONFIG }, cfg) === path.join(CONFIG, 'session-env', 'env-own'),
        'the stray path was used');
}

// 11. --check writes nothing and exits 1 while something is pending.
{
    const dir = sessionDir('check-mode', { 'sessionstart-hook-11.sh': CODEX_BLOCK.repeat(3) });
    const r = run(['--dir', dir, '--check']);
    check('--check: exit 1 when pending', r.code === 1, JSON.stringify(r));
    check('--check: wrote nothing', lineCount(path.join(dir, 'sessionstart-hook-11.sh')) === 9, 'file changed');
    check('--check: prints names, not values', /CODEX_COMPANION_SESSION_ID x2/.test(r.out) && !r.out.includes('0f3c9a4e'), r.out);
}

// 12. --all walks every session dir under <config>/session-env and says how many.
{
    const root = path.join(TMP, 'all-config');
    sessionDir('s1', { 'sessionstart-hook-1.sh': CODEX_BLOCK.repeat(2) }, path.join(root, 'session-env'));
    sessionDir('s2', { 'sessionstart-hook-1.sh': CODEX_BLOCK }, path.join(root, 'session-env'));
    fs.writeFileSync(path.join(root, 'session-env', 'stray-file'), 'x', 'utf8');
    const r = run(['--all'], '', { CLAUDE_CONFIG_DIR: root });
    check('--all: rewrote 1 file in 2 session dirs, 3 dead lines', r.code === 0 && /rewrote 1 file\(s\) in 2 session dir\(s\), 3 dead line\(s\)/.test(r.out), JSON.stringify(r));
    const missing = run(['--all'], '', { CLAUDE_CONFIG_DIR: path.join(TMP, 'no-such-config') });
    check('--all: a missing session-env root is exit 2 with a reason, not a zero', missing.code === 2 && /session-env/.test(missing.err) && missing.out === '', JSON.stringify(missing));
    const help = run(['--help']);
    check('--help: prints usage, exit 0', help.code === 0 && /usage:/.test(help.out), JSON.stringify(help));
}

// 13. A file that moves under the planner is left alone: the race guard (plant a concurrent append).
{
    const dir = sessionDir('race', { 'sessionstart-hook-11.sh': CODEX_BLOCK.repeat(2) });
    const file = path.join(dir, 'sessionstart-hook-11.sh');
    const stale = plan([{ name: 'sessionstart-hook-11.sh', text: fs.readFileSync(file, 'utf8') }]);
    fs.appendFileSync(file, "export LATE_ARRIVAL='1'\n", 'utf8');
    const replaced = replaceIfUnchanged(dir, stale[0]);
    check('race: a stale plan is refused', replaced === false, 'the stale plan overwrote the file');
    check('race: the late append is still there', fs.readFileSync(file, 'utf8').includes('LATE_ARRIVAL') && lineCount(file) === 7, fs.readFileSync(file, 'utf8'));
    check('race: no temp file left behind', fs.readdirSync(dir).length === 1, fs.readdirSync(dir).join(','));
    run(['--dir', dir]);
    const after = fs.readFileSync(file, 'utf8');
    check('race: the late append survives the next pass', after.includes('LATE_ARRIVAL') && lineCount(file) === 4, after);
    check('race: the stale plan was for 6 -> 3', stale.length === 1 && stale[0].before === 6 && stale[0].after === 3, JSON.stringify(stale));
}

// 14. The wiring: PreCompact, SessionEnd and SessionStart "resume" run the
//     script with no arguments (validate reads the path up to the first quote,
//     so a trailing flag would read as a missing file).
{
    const cfg = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8')).hooks;
    const wired = (event) => (cfg[event] || []).filter((g) => (g.hooks || []).some((h) => (h.args || []).some((a) => /session-env-dedupe\.js$/.test(a))));
    const exact = (g) => g.hooks.filter((h) => (h.args || []).some((a) => /session-env-dedupe\.js$/.test(a)))
        .every((h) => h.command === 'node' && h.args.length === 1 && h.args[0] === '${CLAUDE_PLUGIN_ROOT}/hooks/session-env-dedupe.js');
    for (const event of ['PreCompact', 'SessionEnd']) {
        const groups = wired(event);
        check(`wired on ${event}, every matcher`, groups.length === 1 && !groups[0].matcher && exact(groups[0]), JSON.stringify(groups));
    }
    const start = wired('SessionStart');
    check('wired on SessionStart for "resume" only', start.length === 1 && start[0].matcher === 'resume' && exact(start[0]), JSON.stringify(start));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${cases - failed}/${cases} passed`);
process.exitCode = failed ? 1 : 0;
