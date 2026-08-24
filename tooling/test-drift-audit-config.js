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

// Narrowing has to actually clear the finding, because that is what the fix
// line tells the reader to do. It did not: the matcher keyed on the command
// NAME, so `Bash(export SP=*)` was reported exactly like `Bash(export *)` and
// deletion was the only move that ever worked. Advice a tool gives has to be
// run against the tool.
{
    const bare = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(export *)'], deny: ['Bash(rm *)'] } } }));
    const narrowed = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(export MSYS_NO_PATHCONV=*)'], deny: ['Bash(rm *)'] } } }));
    check('a bare-wildcard export IS reported', /allow rule/.test(bare));
    check('  narrowing it to one variable CLEARS the finding', !/allow rule/.test(narrowed));

    const bareFetch = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(wget *)'], deny: ['Bash(rm *)'] } } }));
    const narrowFetch = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(wget https://api.github.com/*)'], deny: ['Bash(rm *)'] } } }));
    check('a bare-wildcard wget IS reported', /allow rule/.test(bareFetch));
    check('  pinning it to one host CLEARS the finding', !/allow rule/.test(narrowFetch));
}

// The other class: narrowing must NOT clear a command whose purpose is running
// arbitrary code. Without this the change above would be a way to silence every
// finding by adding an argument.
{
    const narrowedShell = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(bash -c *)'], deny: ['Bash(rm *)'] } } }));
    check('an argument does NOT clear bash -c — it still runs anything',
        /allow rule/.test(narrowedShell));
    const narrowedEval = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(eval "$X")'], deny: ['Bash(rm *)'] } } }));
    check('  nor eval', /allow rule/.test(narrowedEval));
}

// Flags are not constraints: the wildcard is still the target.
{
    const out = run(config({ 'settings.json': {
        permissions: { allow: ['Bash(rm -f *)'], deny: ['Bash(git push *)'] } } }));
    check('a flag does not count as narrowing (rm -f * still reported)', /allow rule/.test(out));
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

// The .last-run heartbeat. The mtime heuristic above has a built-in
// false-positive: a healthy task's SKILL.md is never edited again, so every
// stable task starts warning a week after its last edit whether it fires or
// not. A task that stamps .last-run at the end of every run gives the audit a
// signal that measures firing, and the stamp must win over the mtime.
{
    const cfg = config({
        'scheduled-tasks/stamped-alive/SKILL.md': '# nightly\n',
        'scheduled-tasks/stamped-alive/.last-run': '2026-08-18T00:00:00Z\n',
        'scheduled-tasks/stamped-dead/SKILL.md': '# nightly\n',
        'scheduled-tasks/stamped-dead/.last-run': '2026-08-01T00:00:00Z\n',
    });
    // Both SKILL.md files aged 30d — old enough that the mtime heuristic alone
    // would report BOTH. Only the stale stamp may fire.
    const old = new Date(Date.now() - 30 * 86400000);
    for (const t of ['stamped-alive', 'stamped-dead']) {
        const skill = path.join(cfg, 'scheduled-tasks', t, 'SKILL.md');
        fs.utimesSync(skill, old, old);
    }
    const dead = path.join(cfg, 'scheduled-tasks', 'stamped-dead', '.last-run');
    const staleStamp = new Date(Date.now() - 6 * 86400000);
    fs.utimesSync(dead, staleStamp, staleStamp);
    // stamped-alive's stamp keeps its just-written mtime: a run completed today.

    const out = run(cfg);
    check('a fresh heartbeat suppresses the old-SKILL.md warning entirely', !/stamped-alive/.test(out));
    check('a stale heartbeat is reported', /stamped-dead/.test(out));
    check('  as a stopped run, not an unedited file', /last completed a run 6d ago/.test(out));
    check('  with the cadence it was judged against', /cadence 1d/.test(out));
}

// A stamp can declare its own cadence for non-daily tasks: {"cadence_days": 7}
// at 6 days old is on schedule; the same stamp at 12 days is not.
{
    const cfg = config({
        'scheduled-tasks/weekly-on-time/SKILL.md': '# weekly\n',
        'scheduled-tasks/weekly-on-time/.last-run': '{"cadence_days": 7}\n',
        'scheduled-tasks/weekly-overdue/SKILL.md': '# weekly\n',
        'scheduled-tasks/weekly-overdue/.last-run': '{"cadence_days": 7}\n',
    });
    const age = (task, days) => {
        const d = new Date(Date.now() - days * 86400000);
        fs.utimesSync(path.join(cfg, 'scheduled-tasks', task, '.last-run'), d, d);
        // SKILL.md aged too, so any hit below is attributable to the stamp path.
        fs.utimesSync(path.join(cfg, 'scheduled-tasks', task, 'SKILL.md'), d, d);
    };
    age('weekly-on-time', 6);
    age('weekly-overdue', 12);

    const out = run(cfg);
    check('a weekly stamp 6d old is on schedule', !/weekly-on-time/.test(out));
    check('a weekly stamp 12d old is reported', /weekly-overdue/.test(out));
    check('  judged against its declared cadence', /cadence 7d/.test(out));
}

// A junk cadence must fall back to daily, not be believed. A negative one that
// slipped through would make (cadence + 2) negative, so a stamp written MINUTES
// ago reads as overdue — a fresh heartbeat reported as a dead schedule is the
// exact inversion of what the stamp exists to prevent.
{
    const cfg = config({
        'scheduled-tasks/junk-cadence/SKILL.md': '# nightly\n',
        'scheduled-tasks/junk-cadence/.last-run': '{"cadence_days": -5}\n',
    });
    check('a fresh stamp with a junk cadence is not reported', !/junk-cadence/.test(run(cfg)));
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
    // "Skipped, not crashed on" needs BOTH halves asserted, and only one of them
    // was. A crash prints a stack and no report, so `!/thing@ghost/` is true of
    // a script that died on line 1 — the assertion passed for the wrong reason.
    //
    // Not hypothetical: the || in `if (!market || !market.installLocation)` is
    // exactly what stops the second test dereferencing an undefined market.
    // Mutating it to && makes this fixture throw a TypeError with zero stdout,
    // and the old assertion stayed green. It was one of five mutants surviving
    // both suites in the 2026-08-19 sweep.
    //
    // "Drift audit —" is the report header, printed only once the run reaches
    // the reporting stage, so it separates a quiet skip from a dead process.
    const orphanOut = run(orphanMarket);
    check('an entry whose marketplace is unknown is skipped quietly',
        !/thing@ghost/.test(orphanOut));
    check('  and the run COMPLETED rather than crashing on it',
        /Drift audit —/.test(orphanOut));
}

// No plugin files at all — the normal state on a fresh machine.
{
    const bareOut = run(config({ 'settings.json': {} }));
    check('a config with no plugin files produces no plugin findings',
        !/is installed at/.test(bareOut));
    check('  and that run COMPLETED too', /Drift audit —/.test(bareOut));
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

// Past a handful, the list collapses to one line. Cherry-picking from a large
// catalog is not drift, and naming each one buried everything else: measured
// 2026-08-19, one 286-plugin marketplace produced 259 of 277 total findings.
//
// Both sides of the threshold are pinned. A test for the summary alone would
// pass just as well if naming had been removed altogether, which would throw
// away the case the check was written for.
{
    const big = path.join(TMP, 'big-catalog');
    fs.mkdirSync(path.join(big, '.claude-plugin'), { recursive: true });
    // 1 installed, 20 not — comfortably past the limit.
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `p${i}` }));
    fs.writeFileSync(path.join(big, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ plugins: many }));
    const outBig = run(config({
        'plugins/known_marketplaces.json': { big: { installLocation: big } },
        'plugins/installed_plugins.json': { plugins: { 'p0@big': [{ version: '1.0.0' }] } },
    }));
    check('a large catalog is summarised, not enumerated', /20 of 21 published plugins/.test(outBig));
    check('  and no individual plugin is named', !/p7@big is published/.test(outBig));

    // The other side: at or under the limit, names are still what you want.
    const small = path.join(TMP, 'small-catalog');
    fs.mkdirSync(path.join(small, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(small, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ plugins: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }));
    const outSmall = run(config({
        'plugins/known_marketplaces.json': { sm: { installLocation: small } },
        'plugins/installed_plugins.json': { plugins: { 'a@sm': [{ version: '1.0.0' }] } },
    }));
    check('a small marketplace still names each missing plugin',
        /b@sm is published/.test(outSmall) && /c@sm is published/.test(outSmall));
    check('  and is not summarised', !/published plugins are not installed/.test(outSmall));

    // A fully installed marketplace says nothing at all — the summary must not
    // fire on zero.
    const full = run(config({
        'plugins/known_marketplaces.json': { sm: { installLocation: small } },
        'plugins/installed_plugins.json': { plugins: {
            'a@sm': [{ version: '1.0.0' }], 'b@sm': [{ version: '1.0.0' }], 'c@sm': [{ version: '1.0.0' }] } },
    }));
    check('a fully installed marketplace produces no plugin finding',
        !/published/.test(full));
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
    check('  and says so WITHOUT claiming more than it measured',
        /no drift found in the population above/.test(clean.out));
    // The whole point of the census: a clean run must be distinguishable from a
    // check that ran on nothing. Without this, deleting the census restores a
    // bare all-clear and every suite still passes.
    check('  and prints the population it scanned on the CLEAN path',
        /settings: settings\.json read, \d+ permission entries/.test(clean.out));

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
