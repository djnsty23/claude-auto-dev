#!/usr/bin/env node
'use strict';
// test-ledger-lock-mark.js: the locking-window's writer. ledger-lock.js leaves one empty
// marker per writer, plugin version and day when a module running from the plugin cache
// takes a lock, and nothing when it runs from a source checkout.
//
// The real ledger-lock.js bytes are copied into a fake plugin cache tree and a fake source
// tree, and driven by caller scripts as subprocesses with CLAUDE_CONFIG_DIR in the temp dir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname, '../plugins/autodev-core/scripts');
let ran = 0;
let failed = 0;
function check(name, cond, detail) {
    ran++;
    if (cond) { console.log(`ok ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(0, 600)}` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-mark-'));
const cfg = path.join(root, 'claude');
const marks = path.join(cfg, 'autodev', 'windows', 'lock-writers');
function tree(base, version) {
    fs.mkdirSync(path.join(base, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(base, 'hooks'), { recursive: true });
    for (const f of ['ledger-lock.js', 'claude-paths.js', 'gate-identity.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(base, 'scripts', f));
    if (version) {
        fs.mkdirSync(path.join(base, '.claude-plugin'), { recursive: true });
        fs.writeFileSync(path.join(base, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'autodev-core', version }));
    }
    const body = (rel) => `const { withLedgerLock, acquireLock } = require(${JSON.stringify(rel)});
const file = require('path').join(${JSON.stringify(root)}, 'ledger-' + process.argv[2] + '.json');
withLedgerLock(file, () => require('fs').writeFileSync(file, '{}'));
const h = acquireLock(file + '.second-lock', { waitMs: 1000 });
if (h.acquired) h.release();
console.log('locked');
`;
    fs.writeFileSync(path.join(base, 'scripts', 'writer-a.js'), body('./ledger-lock.js'));
    fs.writeFileSync(path.join(base, 'hooks', 'writer-b.js'), body('../scripts/ledger-lock.js'));
}
const cache = path.join(root, 'plugins', 'cache', 'autodev', 'autodev-core', '9.9.9');
const unversioned = path.join(root, 'plugins', 'cache', 'autodev', 'autodev-core', '0.0.0-bare');
const source = path.join(root, 'checkout', 'plugins', 'autodev-core');
tree(cache, '9.9.9');
tree(unversioned, null);
tree(source, '9.9.9');
const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, HOME: root, USERPROFILE: root };
delete env.AUTODEV_LOCK_TEST_SKEW_MS;
const run = (file, tag, extra = {}) => spawnSync(process.execPath, [file, tag], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
const listAll = () => { try { return fs.readdirSync(marks).flatMap((d) => fs.readdirSync(path.join(marks, d)).map((n) => `${d}/${n}`)).sort(); } catch { return []; } };

try {
    const today = new Date().toISOString().slice(0, 10);
    let r = run(path.join(source, 'scripts', 'writer-a.js'), 's1');
    check('a writer running from a source checkout takes its lock and leaves no mark', r.status === 0 && /locked/.test(r.stdout) && listAll().length === 0, `${r.stdout}${r.stderr} ${listAll()}`);

    r = run(path.join(cache, 'scripts', 'writer-a.js'), 'c1');
    check('a writer running from the plugin cache leaves one mark naming its dir, file and version',
        r.status === 0 && listAll().join() === `${today}/scripts~writer-a.js@9.9.9`, `${r.stderr} ${listAll()}`);
    const mark = path.join(marks, today, 'scripts~writer-a.js@9.9.9');
    check('the mark is an empty file', fs.existsSync(mark) && fs.statSync(mark).size === 0);

    r = run(path.join(cache, 'scripts', 'writer-a.js'), 'c2');
    check('a second process on the same day adds no mark and still succeeds', r.status === 0 && listAll().length === 1, `${r.stderr} ${listAll()}`);

    r = run(path.join(cache, 'hooks', 'writer-b.js'), 'c3');
    check('a hook that requires ../scripts/ledger-lock.js is marked as hooks~<file>', r.status === 0 && listAll().includes(`${today}/hooks~writer-b.js@9.9.9`), listAll().join());

    r = run(path.join(unversioned, 'scripts', 'writer-a.js'), 'u1');
    check('a cache tree with no plugin.json is marked with version unknown', r.status === 0 && listAll().includes(`${today}/scripts~writer-a.js@unknown`), listAll().join());

    const skew = 3 * 24 * 60 * 60 * 1000;
    const later = new Date(Date.now() + skew).toISOString().slice(0, 10);
    r = run(path.join(cache, 'scripts', 'writer-a.js'), 'c4', { AUTODEV_LOCK_TEST_SKEW_MS: String(skew) });
    check('a later day gets its own mark', r.status === 0 && listAll().includes(`${later}/scripts~writer-a.js@9.9.9`), listAll().join());

    // The mark directory is unwritable: the lock must still be taken and the ledger written.
    fs.rmSync(marks, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(marks), { recursive: true });
    fs.writeFileSync(marks, 'a file where the directory should be');
    r = run(path.join(cache, 'scripts', 'writer-a.js'), 'c5');
    check('an unwritable mark directory never fails the write', r.status === 0 && /locked/.test(r.stdout) && fs.existsSync(path.join(root, 'ledger-c5.json')), r.stdout + r.stderr);
} catch (e) {
    failed++;
    console.log(`FAIL the suite crashed: ${e.stack || e}`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\nledger-lock mark: ${ran - failed}/${ran} checks passed`);
process.exitCode = failed ? 1 : 0;
