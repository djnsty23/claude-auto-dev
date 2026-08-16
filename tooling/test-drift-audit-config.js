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

// Same, but keeping the status — the exit code IS the contract for anything
// wiring this into CI, and asserting output alone leaves it free to invert.
function runFull(cfg, extra = []) {
    const r = spawnSync(process.execPath, [AUDIT, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, HOME: path.join(TMP, 'home'), USERPROFILE: path.join(TMP, 'home') },
    });
    return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
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

// ------------------------------- published-but-not-installed, and the manifest

// A whole feature with no test: a plugin published in a marketplace you ALREADY
// USE but have not installed. All three mutations on its guard survived. This is
// how one plugin sat uninstalled while its sibling was in daily use.
{
    const clone2 = path.join(TMP, 'catalog-clone');
    fs.mkdirSync(path.join(clone2, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(clone2, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ plugins: [{ name: 'core' }, { name: 'extra' }] }));

    const adopted = config({
        'plugins/known_marketplaces.json': { mk: { installLocation: clone2 } },
        'plugins/installed_plugins.json': { plugins: { 'core@mk': [{ version: '1.0.0' }] } },
    });
    const out = run(adopted);
    check('a published-but-uninstalled sibling is reported', /extra@mk/.test(out));
    check('  and the one you DO have installed is not', !/core@mk is published/.test(out));

    // The marketplace you have adopted nothing from is none of your business.
    const unadopted = config({
        'plugins/known_marketplaces.json': { mk: { installLocation: clone2 } },
        'plugins/installed_plugins.json': { plugins: { 'thing@other': [{ version: '1.0.0' }] } },
    });
    check('a marketplace you use nothing from is not advertised',
        !/extra@mk/.test(run(unadopted)));
}

// An install path whose manifest is gone is a broken install, not drift.
//
// The marketplace clone has to be a REAL git repo: the sha comparison runs
// first, and `git rev-parse` in a directory that does not exist throws straight
// into a `continue` — so with a fake installLocation this check is unreachable
// and the first version of this case failed for that reason, not because the
// code was wrong.
{
    const repo2 = path.join(TMP, 'manifest-clone');
    fs.mkdirSync(repo2, { recursive: true });
    const g2 = (...a) => execSync('git ' + a.join(' '), { cwd: repo2, stdio: 'ignore' });
    g2('init', '-q'); g2('config', 'user.email', 't@t'); g2('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo2, 'x.txt'), 'x');
    g2('add', '-A'); g2('commit', '-qm', 'init');
    const sha = execSync('git rev-parse HEAD', { cwd: repo2, encoding: 'utf8' }).trim();

    const gone = path.join(TMP, 'installed-but-empty');
    fs.mkdirSync(gone, { recursive: true });        // exists, but no .claude-plugin/plugin.json
    const out = run(config({
        'plugins/known_marketplaces.json': { mk: { installLocation: repo2 } },
        'plugins/installed_plugins.json': {
            // matching sha, so the ONLY thing that can fire is the manifest check
            plugins: { 'broken@mk': [{ version: '1.0.0', gitCommitSha: sha, installPath: gone }] } },
    }));
    check('an installPath missing its manifest is reported', /installPath is missing its manifest/.test(out));

    // And a healthy install must not be reported.
    const ok = path.join(TMP, 'installed-ok');
    fs.mkdirSync(path.join(ok, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(ok, '.claude-plugin', 'plugin.json'), '{"name":"fine"}');
    const clean = run(config({
        'plugins/known_marketplaces.json': { mk: { installLocation: repo2 } },
        'plugins/installed_plugins.json': {
            plugins: { 'fine@mk': [{ version: '1.0.0', gitCommitSha: sha, installPath: ok }] } },
    }));
    check('  and an install WITH its manifest is not', !/missing its manifest/.test(clean));
}

// ---------------------------------------------------- the output contract

// The exit code is what CI reads. `severity === 'fail'` inverted would exit 0 on
// a failure and 1 on a clean run, and no output assertion can see it.
{
    const clean = runFull(config({ 'settings.json': { permissions: { allow: ['Bash(npm test)'], deny: [] } } }));
    check('a clean config exits 0', clean.status === 0);
    check('  and says everything is current', /are all current/.test(clean.out));

    const failing = runFull(config({ 'settings.json': {
        permissions: { allow: ['Bash(bash -c *)'], deny: ['Bash(rm *)'] } } }));
    check('a FAIL-severity finding exits 1', failing.status === 1);

    // warn/info must NOT fail the run, or the exit code stops meaning anything.
    const warnOnly = runFull(config({ 'settings.json': {
        permissions: { allow: ['Bash(eval *)'], deny: [] } } }));
    check('a warning-only run still exits 0', warnOnly.status === 0);
}

// --json is a separate output path and had no test at all.
{
    const j = runFull(config({ 'settings.json': {
        permissions: { allow: ['Bash(bash -c *)'], deny: ['Bash(rm *)'] } } }), ['--json']);
    let parsed = null;
    try { parsed = JSON.parse(j.out); } catch { /* stays null */ }
    check('--json emits parseable JSON', parsed !== null);
    check('  carrying the findings', !!parsed && Array.isArray(parsed.findings) && parsed.findings.length > 0);
    check('  and the config dir it audited', !!parsed && typeof parsed.configDir === 'string');
    check('  and it still exits 1 on a fail', j.status === 1);
}

// Findings are grouped by area, and the header prints once per area rather than
// once per finding.
{
    const cfg = config({
        'settings.json': { permissions: { allow: ['Bash(eval *)', 'Bash(source *)'], deny: [] } },
    });
    const out = run(cfg);
    check('the area header appears once, not once per finding',
        (out.match(/\[settings\]/g) || []).length === 1);
}

let pass = 0, fail = 0;
for (const [label, ok] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
