#!/usr/bin/env node
// Test harness for the collision-safe sync.js + uninstall.js pair.
// Uses a temp --dest dir so it never touches the real ~/.claude.
//
// Scenarios:
//   1. Fresh install into an empty dest
//   2. Re-sync (sidecar present, no repo changes) — idempotent
//   3. Legacy install (manifest.json present, no sidecar) — treated as pre-owned
//   4. User-owned unrelated skill (my-custom-skill/) — preserved across install + uninstall
//   5. Name collision (user has their own audit/) — refuses without --force
//   6. Name collision with --force — backs up, installs ours
//   7. Uninstall (sidecar-driven) — removes only tracked items
//   8. Uninstall fallback (no sidecar) — manifest-driven

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const syncJs = path.join(repo, 'scripts', 'sync.js');
const uninstallJs = path.join(repo, 'scripts', 'uninstall.js');

function tempDest(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-' + label + '-'));
}

function run(script, extraArgs) {
    const res = spawnSync('node', [script, '--repo', repo, ...extraArgs], { encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function mkfile(p, content) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
}

function exists(p) { return fs.existsSync(p); }

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

let totalFails = 0;
function section(label) { console.log('\n=== ' + label + ' ==='); }
function assert(label, cond) {
    console.log((cond ? '  OK  ' : '  FAIL') + ' ' + label);
    if (!cond) totalFails++;
}

// ---------- Scenario 1: Fresh install ----------
section('1. Fresh install into empty dest');
{
    const dest = tempDest('fresh');
    const res = run(syncJs, ['--dest', dest]);
    assert('exit 0', res.status === 0);
    assert('sidecar created', exists(path.join(dest, '.auto-dev-installed.json')));
    assert('skills/audit/ copied', exists(path.join(dest, 'skills', 'audit', 'SKILL.md')));
    assert('hooks/session-start.js copied', exists(path.join(dest, 'hooks', 'session-start.js')));
    assert('agents/code-reviewer.md copied', exists(path.join(dest, 'agents', 'code-reviewer.md')));
    const sc = readJson(path.join(dest, '.auto-dev-installed.json'));
    assert('sidecar has items', sc && Object.keys(sc.items).length > 30);
    assert('sidecar tracks skills/audit', sc && sc.items['skills/audit'] === 'dir');
    assert('sidecar tracks hooks/session-start.js', sc && sc.items['hooks/session-start.js'] === 'file');
}

// ---------- Scenario 2: Re-sync (idempotent) ----------
section('2. Re-sync with sidecar (idempotent)');
{
    const dest = tempDest('resync');
    run(syncJs, ['--dest', dest]);
    const firstSidecar = readJson(path.join(dest, '.auto-dev-installed.json'));
    const res = run(syncJs, ['--dest', dest]);
    assert('exit 0', res.status === 0);
    assert('no collisions reported', !res.stderr.includes('REFUSING'));
    const secondSidecar = readJson(path.join(dest, '.auto-dev-installed.json'));
    assert('same items set', JSON.stringify(Object.keys(firstSidecar.items).sort()) === JSON.stringify(Object.keys(secondSidecar.items).sort()));
    assert('skills still intact', exists(path.join(dest, 'skills', 'audit', 'SKILL.md')));
}

// ---------- Scenario 3: Legacy install ----------
section('3. Legacy install (manifest present, no sidecar)');
{
    const dest = tempDest('legacy');
    // Seed a fake legacy install: copy over the manifest + one skill dir
    fs.mkdirSync(path.join(dest, 'skills', 'audit'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'skills', 'manifest.json'), path.join(dest, 'skills', 'manifest.json'));
    fs.copyFileSync(path.join(repo, 'skills', 'audit', 'SKILL.md'), path.join(dest, 'skills', 'audit', 'SKILL.md'));
    const res = run(syncJs, ['--dest', dest]);
    assert('exit 0', res.status === 0);
    assert('legacy notice printed', res.stdout.includes('Legacy install detected'));
    assert('sidecar created', exists(path.join(dest, '.auto-dev-installed.json')));
    assert('no collision error', !res.stderr.includes('REFUSING'));
}

// ---------- Scenario 4: User-owned unrelated skill ----------
section('4. User-owned unrelated skill preserved');
{
    const dest = tempDest('user-skill');
    mkfile(path.join(dest, 'skills', 'my-custom-skill', 'SKILL.md'), '# My custom skill\n');
    const res = run(syncJs, ['--dest', dest]);
    assert('install exit 0', res.status === 0);
    assert('user skill survived install', exists(path.join(dest, 'skills', 'my-custom-skill', 'SKILL.md')));
    assert('our audit still installed', exists(path.join(dest, 'skills', 'audit', 'SKILL.md')));

    // Now uninstall — user skill must still be there
    const ures = run(uninstallJs, ['--dest', dest]);
    assert('uninstall exit 0', ures.status === 0);
    assert('user skill survived uninstall', exists(path.join(dest, 'skills', 'my-custom-skill', 'SKILL.md')));
    assert('our audit removed', !exists(path.join(dest, 'skills', 'audit')));
    assert('sidecar removed', !exists(path.join(dest, '.auto-dev-installed.json')));
}

// ---------- Scenario 5: Collision without --force ----------
section('5. Name collision without --force (should refuse)');
{
    const dest = tempDest('collide');
    // Seed a user-owned audit/ that differs from ours
    mkfile(path.join(dest, 'skills', 'audit', 'SKILL.md'), '# MY audit skill, different content\n');
    const res = run(syncJs, ['--dest', dest]);
    assert('exit nonzero', res.status !== 0);
    assert('refusal message', res.stderr.includes('REFUSING TO OVERWRITE'));
    assert('lists skills/audit collision', res.stderr.includes('skills/audit'));
    assert('user audit untouched', fs.readFileSync(path.join(dest, 'skills', 'audit', 'SKILL.md'), 'utf8').startsWith('# MY audit'));
    assert('no sidecar written', !exists(path.join(dest, '.auto-dev-installed.json')));
}

// ---------- Scenario 6: Collision with --force ----------
section('6. Name collision with --force (back up + overwrite)');
{
    const dest = tempDest('collide-force');
    mkfile(path.join(dest, 'skills', 'audit', 'SKILL.md'), '# MY audit skill, different content\n');
    const res = run(syncJs, ['--dest', dest, '--force']);
    assert('exit 0', res.status === 0);
    assert('backup notice', res.stdout.includes('backing up'));
    // Find the backup dir
    const backups = fs.readdirSync(dest).filter(n => n.startsWith('.user-backup-'));
    assert('backup dir created', backups.length === 1);
    if (backups.length === 1) {
        const backupContent = fs.readFileSync(path.join(dest, backups[0], 'skills', 'audit', 'SKILL.md'), 'utf8');
        assert('backup preserved user content', backupContent.startsWith('# MY audit'));
    }
    assert('our audit now installed', fs.readFileSync(path.join(dest, 'skills', 'audit', 'SKILL.md'), 'utf8').length > 100);
    assert('sidecar written', exists(path.join(dest, '.auto-dev-installed.json')));
}

// ---------- Scenario 7: Uninstall (sidecar-driven) ----------
section('7. Uninstall via sidecar');
{
    const dest = tempDest('uninstall-sidecar');
    run(syncJs, ['--dest', dest]);
    // Add a user file that sidecar doesn't know about
    mkfile(path.join(dest, 'skills', 'my-skill', 'SKILL.md'), 'user\n');
    mkfile(path.join(dest, 'hooks', 'my-hook.js'), '// user hook\n');
    const ures = run(uninstallJs, ['--dest', dest]);
    assert('exit 0', ures.status === 0);
    assert('sidecar strategy used', ures.stdout.includes('Using install sidecar'));
    assert('our skill removed', !exists(path.join(dest, 'skills', 'audit')));
    assert('user skill preserved', exists(path.join(dest, 'skills', 'my-skill', 'SKILL.md')));
    assert('user hook preserved', exists(path.join(dest, 'hooks', 'my-hook.js')));
}

// ---------- Scenario 8: Uninstall fallback (no sidecar) ----------
section('8. Uninstall fallback (no sidecar, legacy install)');
{
    const dest = tempDest('uninstall-legacy');
    // Seed legacy: copy the skills and hooks the old way
    for (const name of ['audit', 'commit']) {
        fs.mkdirSync(path.join(dest, 'skills', name), { recursive: true });
        fs.copyFileSync(path.join(repo, 'skills', name, 'SKILL.md'), path.join(dest, 'skills', name, 'SKILL.md'));
    }
    fs.mkdirSync(path.join(dest, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'hooks', 'session-start.js'), path.join(dest, 'hooks', 'session-start.js'));
    // User content
    mkfile(path.join(dest, 'skills', 'my-skill', 'SKILL.md'), 'user\n');
    const ures = run(uninstallJs, ['--dest', dest]);
    assert('exit 0', ures.status === 0);
    assert('fallback strategy used', ures.stdout.includes('No sidecar found'));
    assert('our audit removed', !exists(path.join(dest, 'skills', 'audit')));
    assert('our hook removed', !exists(path.join(dest, 'hooks', 'session-start.js')));
    assert('user skill preserved', exists(path.join(dest, 'skills', 'my-skill', 'SKILL.md')));
}

// ---------- Summary ----------
console.log('\n=== Summary ===');
console.log(totalFails === 0 ? 'ALL PASS' : totalFails + ' FAIL');
process.exit(totalFails === 0 ? 0 : 1);
