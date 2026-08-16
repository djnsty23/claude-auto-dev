#!/usr/bin/env node
// Tests for drift-audit.js — the CONFIG half: auditPlugins, auditSchedules and
// auditSettings.
//
// The sibling suite tests the prd.json half and says so in its header. These
// three audits had no suite at all, which a 22-minute mutation run reported as
// 37 surviving mutants. They are not subtle gaps — nothing asserted on this code
// at all, so every mutant in it survived by default.
//
// All three read from CLAUDE_CONFIG_DIR, so each case builds a throwaway config
// tree and reads the audit's own output back. auditPlugins additionally needs a
// real git repo, because the whole signal is "installed sha vs clone HEAD".
//
// Run: node tooling/test-drift-audit-config.js

const { spawnSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUDIT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'drift-audit.js');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'drift-cfg-')));

const cases = [];
const check = (label, ok) => cases.push([label, ok]);

let n = 0;
function config(files = {}) {
    const dir = path.join(TMP, 'cfg' + ++n);
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Runs the audit against a config dir and returns its stdout. HOME is redirected
// too, so a machine's real ~/.claude can never leak into a case.
function run(cfg) {
    const r = spawnSync(process.execPath, [AUDIT], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, HOME: path.join(TMP, 'home'), USERPROFILE: path.join(TMP, 'home') },
    });
    return (r.stdout || '') + (r.stderr || '');
}

// ------------------------------------------------------------- auditSettings

// An allow rule that can run any command makes every deny rule decorative.
{
    const cfg = config({ 'settings.json': {
        permissions: { allow: ['Bash(bash -c *)'], deny: ['Bash(rm -rf /)', 'Bash(git push --force *)'] },
    } });
    const out = run(cfg);
    check('a shell-escape allow rule is reported', /bash/i.test(out) && /allow rule/.test(out));
    check('  and it says how many deny rules it bypasses', /2 deny rules/.test(out));
}

// Severity depends on whether there is anything to bypass: with no deny list the
// same rule is a warning, not a failure. Both branches, or the ternary is free
// to be inverted.
{
    const withDeny = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(eval *)'], deny: ['Bash(rm *)'] } } }));
    const noDeny = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(eval *)'], deny: [] } } }));
    check('with deny rules present the escape is a FAIL', /✗|fail/i.test(withDeny));
    check('with no deny rules it is only a warning',
        /eval/.test(noDeny) && !/1 deny rules/.test(noDeny));
}

// A grant is stale when the DIRECTORY it lives in is gone — not merely when the
// leaf file has not been created yet, which is a normal, deliberate grant.
{
    const live = path.join(TMP, 'live-dir');
    fs.mkdirSync(live, { recursive: true });
    const out = run(config({ 'settings.json': {
        permissions: {
            allow: [`Edit(${path.join(live, 'not-created-yet.log')})`, 'Edit(/no/such/directory/at/all/x.log)'],
            deny: [],
        } } }));
    check('a grant on a not-yet-created file in a LIVE directory is left alone',
        !/not-created-yet/.test(out));
    check('  but a grant into a directory that is gone is reported',
        /no\/such\/directory/.test(out));
}

// A settings file with nothing wrong must produce nothing.
{
    const out = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(npm test)', 'Read(~/notes)'], deny: ['Bash(rm -rf /)'] } } }));
    check('a clean settings.json produces no settings finding', !/allow rule/.test(out));
}

// ------------------------------------------------------------ auditSchedules

{
    const cfg = config({
        'scheduled-tasks/nightly-audit/SKILL.md': '# nightly\n',
        'scheduled-tasks/fresh-task/SKILL.md': '# fresh\n',
    });
    // Age only the first one past the week the audit cares about.
    const stale = path.join(cfg, 'scheduled-tasks', 'nightly-audit', 'SKILL.md');
    const old = new Date(Date.now() - 30 * 86400000);
    fs.utimesSync(stale, old, old);

    const out = run(cfg);
    check('a scheduled task untouched for 30d is reported', /nightly-audit/.test(out));
    check('  with the age in days', /30d/.test(out));
    check('a task touched today is NOT reported', !/fresh-task/.test(out));
}

// A directory with no SKILL.md is not a task; it must not be reported.
{
    const cfg = config({ 'scheduled-tasks/not-a-task/readme.txt': 'x' });
    const dir = path.join(cfg, 'scheduled-tasks', 'not-a-task');
    const old = new Date(Date.now() - 60 * 86400000);
    fs.utimesSync(dir, old, old);
    check('a directory without SKILL.md is not treated as a task',
        !/not-a-task/.test(run(cfg)));
}

// ------------------------------------------------------------- auditPlugins

// The signal is "installed sha vs marketplace clone HEAD", so the case needs a
// real repo — a fake sha would let the comparison pass while being wrong about
// the only thing it measures.
{
    const clone = path.join(TMP, 'market-clone');
    fs.mkdirSync(clone, { recursive: true });
    const git = (...a) => execSync('git ' + a.join(' '), { cwd: clone, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(clone, 'f.txt'), 'one');
    git('add', '-A'); git('commit', '-qm', 'one');
    const head = execSync('git rev-parse HEAD', { cwd: clone, encoding: 'utf8' }).trim();

    const mk = (sha) => config({
        'plugins/known_marketplaces.json': { mymarket: { installLocation: clone } },
        'plugins/installed_plugins.json': {
            plugins: { 'thing@mymarket': [{ version: '1.2.3', gitCommitSha: sha }] },
        },
    });

    check('installed sha matching clone HEAD reports nothing',
        !/thing@mymarket/.test(run(mk(head))));

    const behind = run(mk('0'.repeat(40)));
    check('an installed sha behind the clone is reported', /thing@mymarket/.test(behind));
    check('  and names the installed version', /1\.2\.3/.test(behind));

    // A marketplace the config does not know about must be skipped, not crashed on.
    const orphanMarket = config({
        'plugins/known_marketplaces.json': {},
        'plugins/installed_plugins.json': {
            plugins: { 'thing@ghost': [{ version: '1.0.0', gitCommitSha: 'abc' }] } },
    });
    check('an entry whose marketplace is unknown is skipped quietly',
        !/thing@ghost/.test(run(orphanMarket)));
}

// No plugin files at all — the normal state on a fresh machine.
{
    check('a config with no plugin files produces no plugin findings',
        !/is installed at/.test(run(config({ 'settings.json': {} }))));
}

// ---------------------------------------------------------------- report

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
