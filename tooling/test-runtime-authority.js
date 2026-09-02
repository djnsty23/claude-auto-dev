#!/usr/bin/env node
// Acceptance tests for F4: installed_plugins.json is the runtime authority and
// every shipped plugin belongs to the checked population. Expected failures
// before the fix: an inert newest core cache masks an older active pin, and a
// core-only install is reported clean while two declared plugins are absent.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK = path.join(ROOT, 'tooling', 'check-runtime.js');
const PLUGINS = ['autodev-core', 'autodev-memory', 'autodev-stack'];
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-authority-'));

const sourceVersion = (plugin) => JSON.parse(fs.readFileSync(path.join(
    ROOT, 'plugins', plugin, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const versions = Object.fromEntries(PLUGINS.map((plugin) => [plugin, sourceVersion(plugin)]));

const previousVersion = (version) => {
    const parts = version.split('.').map(Number);
    if (parts[2] > 0) parts[2] -= 1;
    else if (parts[1] > 0) parts[1] -= 1;
    else parts[0] = Math.max(0, parts[0] - 1);
    return parts.join('.');
};

const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const detail = (r) => `status=${r.status} signal=${r.signal} error=${r.error?.message || 'none'}`;

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function writeCachedPlugin(root, plugin, version) {
    writeJson(path.join(root, '.claude-plugin', 'plugin.json'), { name: plugin, version });
    if (plugin !== 'autodev-core') return;
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'hooks', 'agent-browser-cleanup.js'), '// fixture\n');
    writeJson(path.join(root, 'hooks', 'hooks.json'), {
        hooks: ['agent-browser-cleanup.js'],
    });
    fs.mkdirSync(path.join(root, 'skills', 'rule-options-protocol'), { recursive: true });
}

function buildHome(name, installedPlugins, extraCoreVersion) {
    const home = path.join(tempRoot, name);
    const claude = path.join(home, '.claude');
    const clone = path.join(claude, 'plugins', 'marketplaces', 'autodev');
    const cache = path.join(claude, 'plugins', 'cache', 'autodev');
    fs.mkdirSync(clone, { recursive: true });

    const git = (...args) => execFileSync('git', args, {
        cwd: clone,
        encoding: 'utf8',
        stdio: 'pipe',
        windowsHide: true,
    });
    git('init');
    git('config', 'user.name', 'Test Fixture');
    git('config', 'user.email', 'test@example.invalid');
    for (const plugin of PLUGINS) {
        writeJson(path.join(clone, 'plugins', plugin, '.claude-plugin', 'plugin.json'), {
            name: plugin,
            version: versions[plugin],
        });
    }
    const message = path.join(home, 'commit-message.txt');
    fs.writeFileSync(message, 'test fixture\n');
    git('add', 'plugins');
    git('commit', '-F', message);
    const sha = git('rev-parse', 'HEAD').trim();

    const manifest = { plugins: {} };
    for (const [plugin, version] of Object.entries(installedPlugins)) {
        const installPath = path.join(cache, plugin, version);
        writeCachedPlugin(installPath, plugin, version);
        manifest.plugins[`${plugin}@autodev`] = [{
            version,
            gitCommitSha: sha,
            installPath,
            scope: 'user',
        }];
    }
    if (extraCoreVersion) {
        writeCachedPlugin(path.join(cache, 'autodev-core', extraCoreVersion),
            'autodev-core', extraCoreVersion);
    }
    writeJson(path.join(claude, 'plugins', 'installed_plugins.json'), manifest);
    return home;
}

const nextVersion = (version) => {
    const parts = version.split('.').map(Number);
    parts[1] += 1; parts[2] = 0;
    return parts.join('.');
};

function run(home, args = []) {
    return spawnSync(process.execPath, [CHECK, ...args], {
        cwd: ROOT,
        env: { ...process.env, USERPROFILE: home, HOME: home },
        encoding: 'utf8',
        windowsHide: true,
    });
}

try {
    const allCurrent = { ...versions };
    const cleanHome = buildHome('clean', allCurrent);
    const homeProbe = spawnSync(process.execPath, ['-p', 'require("os").homedir()'], {
        env: { ...process.env, USERPROFILE: cleanHome, HOME: cleanHome },
        encoding: 'utf8',
        windowsHide: true,
    });
    check('control: the child runtime resolves the isolated fixture home',
        path.resolve(homeProbe.stdout.trim()) === path.resolve(cleanHome),
        `resolved=${JSON.stringify(homeProbe.stdout.trim())}`);

    const clean = run(cleanHome);
    check('control: all three current pins and cached trees pass',
        clean.status === 0 && clean.signal === null && !clean.error,
        detail(clean));

    const stalePins = { ...versions, 'autodev-core': previousVersion(versions['autodev-core']) };
    const staleHome = buildHome('stale-pin', stalePins, versions['autodev-core']);
    const stale = run(staleHome);
    check('an inert newest cache cannot hide an older active core pin',
        stale.status === 1 && stale.signal === null && !stale.error && !stale.stderr.trim(),
        detail(stale));

    // --pre-release: an install BEHIND the source is the normal state before a
    // push, so gate:release could never pass while it counted as a failure.
    // The control is the SAME fixture without the flag, which must still fail,
    // otherwise a passing run would prove the fixture harmless rather than the
    // flag effective.
    const preBehind = run(staleHome, ['--pre-release']);
    check('--pre-release passes an install merely BEHIND the source',
        preBehind.status === 0 && preBehind.signal === null && !preBehind.error,
        detail(preBehind));
    check('control: the same fixture WITHOUT the flag still fails',
        stale.status === 1,
        detail(stale));
    check('  and the behind line is reported as INFO, not dropped',
        preBehind.stdout.includes("[INFO]") && preBehind.stdout.includes("active pin is"),
        'stdout had no INFO pin line');

    check('  and the summary does NOT claim the runtime is current',
        !preBehind.stdout.includes('Runtime is current'),
        'a reassuring label on a deferred check reports absence as a pass');
    check('  and it names the deferral instead',
        preBehind.stdout.includes('DEFERRED'),
        'stdout had no DEFERRED summary');
    check('control: a fully current install DOES say the runtime is current',
        clean.stdout.includes('Runtime is current'),
        'the positive wording is unreachable, so the assertion above proves nothing');

    // The flag must not blanket-pass. An install AHEAD of the source still
    // means the code you edited is not the code that runs, and no push fixes it.
    const aheadPins = { ...versions, 'autodev-core': nextVersion(versions['autodev-core']) };
    const aheadHome = buildHome('ahead-pin', aheadPins);
    const preAhead = run(aheadHome, ['--pre-release']);
    check('--pre-release still FAILS an install AHEAD of the source',
        preAhead.status === 1 && preAhead.signal === null && !preAhead.error,
        detail(preAhead));

    const coreOnlyHome = buildHome('core-only', {
        'autodev-core': versions['autodev-core'],
    });
    const coreOnly = run(coreOnlyHome);
    check('a core-only manifest fails the declared three-plugin population',
        coreOnly.status === 1 && coreOnly.signal === null && !coreOnly.error && !coreOnly.stderr.trim(),
        detail(coreOnly));
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let pass = 0;
let fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
