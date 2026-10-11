'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withLedgerLock, writeAtomic } = require('../plugins/autodev-core/scripts/ledger-lock.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-lock-'));
const file = path.join(root, 'ledger.json');
const originalOpen = fs.openSync;
const originalRename = fs.renameSync;
let passed = 0;
let failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
}
try {
    check('control locks before mutation and releases after success', () => {
        assert.equal(withLedgerLock(file, () => {
            assert.ok(fs.existsSync(file + '.write-lock'));
            writeAtomic(file, '{"control":true}');
            return 42;
        }), 42);
        assert.deepEqual(JSON.parse(fs.readFileSync(file)), { control: true });
        assert.ok(!fs.existsSync(file + '.write-lock'));
    });
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        check('exclusive create retries ' + code, () => {
            let attempts = 0;
            fs.openSync = function (target, flags, ...rest) {
                if (target === file + '.write-lock' && flags === 'wx' && ++attempts <= 2) {
                    throw Object.assign(new Error('create plant'), { code });
                }
                return originalOpen.call(this, target, flags, ...rest);
            };
            try { assert.equal(withLedgerLock(file, () => 'written'), 'written'); }
            finally { fs.openSync = originalOpen; }
            assert.equal(attempts, 3);
        });
        check('atomic replacement retries ' + code, () => {
            let attempts = 0;
            fs.renameSync = function (...args) {
                if (++attempts <= 2) throw Object.assign(new Error('rename plant'), { code });
                return originalRename.apply(this, args);
            };
            try { writeAtomic(file, JSON.stringify({ code })); }
            finally { fs.renameSync = originalRename; }
            assert.equal(attempts, 3);
            assert.equal(JSON.parse(fs.readFileSync(file)).code, code);
        });
    }
    check('held lock never executes mutation and fails within a bounded wait', () => {
        fs.writeFileSync(file + '.write-lock', 'owner');
        const start = performance.now();
        let called = false;
        assert.throws(() => withLedgerLock(file, () => { called = true; }, { waitMs: 30 }), { code: 'LEDGER_LOCKED' });
        assert.equal(called, false);
        assert.ok(performance.now() - start < 1000);
        assert.equal(fs.readFileSync(file + '.write-lock', 'utf8'), 'owner');
        fs.unlinkSync(file + '.write-lock');
    });
    check('callback failure releases the lock without swallowing the cause', () => {
        assert.throws(() => withLedgerLock(file, () => { throw new Error('callback plant'); }), /callback plant/);
        assert.ok(!fs.existsSync(file + '.write-lock'));
    });
    check('a lock recording an exited child pid is reclaimed', () => {
        const child = spawnSync(process.execPath, ['-e', '0']);
        assert.equal(child.status, 0, child.error?.message);
        assert.ok(child.pid > 0);
        assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
        console.log('CONTROL exited child pid=' + child.pid + ' probe=ESRCH');
        fs.writeFileSync(file + '.write-lock', JSON.stringify({ pid: child.pid }));
        try {
            assert.equal(withLedgerLock(file, () => 'reclaimed', { waitMs: 30 }), 'reclaimed');
            assert.ok(!fs.existsSync(file + '.write-lock'));
        } finally { fs.rmSync(file + '.write-lock', { force: true }); }
    });
    check('a live pid lock is preserved even when one hour old', () => {
        const content = JSON.stringify({ pid: process.pid, token: 'live-owner' });
        const old = new Date(Date.now() - 60 * 60 * 1000);
        assert.doesNotThrow(() => process.kill(process.pid, 0));
        fs.writeFileSync(file + '.write-lock', content);
        fs.utimesSync(file + '.write-lock', old, old);
        try {
            assert.throws(() => withLedgerLock(file, () => assert.fail('must not mutate'), { waitMs: 30 }), { code: 'LEDGER_LOCKED' });
            assert.equal(fs.readFileSync(file + '.write-lock', 'utf8'), content);
        } finally { fs.rmSync(file + '.write-lock', { force: true }); }
    });
    for (const content of ['', 'unparseable']) {
        check('an ownerless lock older than 11 minutes is reclaimed: ' + JSON.stringify(content), () => {
            const old = new Date(Date.now() - 11 * 60 * 1000);
            fs.writeFileSync(file + '.write-lock', content);
            fs.utimesSync(file + '.write-lock', old, old);
            try {
                assert.equal(withLedgerLock(file, () => 'reclaimed', { waitMs: 30 }), 'reclaimed');
                assert.ok(!fs.existsSync(file + '.write-lock'));
            } finally { fs.rmSync(file + '.write-lock', { force: true }); }
        });
    }
    check('a denied pid probe never authorizes reclaiming an old lock', () => {
        const originalKill = process.kill;
        const content = JSON.stringify({ pid: process.pid });
        const old = new Date(Date.now() - 60 * 60 * 1000);
        fs.writeFileSync(file + '.write-lock', content);
        fs.utimesSync(file + '.write-lock', old, old);
        let probes = 0;
        process.kill = () => { probes++; throw Object.assign(new Error('probe denied plant'), { code: 'EPERM' }); };
        try {
            assert.throws(() => withLedgerLock(file, () => assert.fail('must not mutate'), { waitMs: 30 }), { code: 'LEDGER_LOCKED' });
            assert.ok(probes > 0);
            assert.equal(fs.readFileSync(file + '.write-lock', 'utf8'), content);
        } finally { process.kill = originalKill; fs.rmSync(file + '.write-lock', { force: true }); }
    });
    check('reclamation preserves a replacement file and retries exclusive create', () => {
        const originalStat = fs.statSync;
        const lock = file + '.write-lock';
        const retired = lock + '.retired';
        const content = JSON.stringify({ pid: process.pid });
        const old = new Date(Date.now() - 11 * 60 * 1000);
        fs.writeFileSync(lock, '');
        fs.utimesSync(lock, old, old);
        let stats = 0;
        let creates = 0;
        fs.openSync = function (target, flags, ...rest) {
            if (target === lock && flags === 'wx') creates++;
            return originalOpen.call(this, target, flags, ...rest);
        };
        fs.statSync = function (target, ...rest) {
            if (target === lock && ++stats === 2) {
                fs.renameSync(lock, retired);
                fs.writeFileSync(lock, content);
                assert.notEqual(originalStat(lock).ino, originalStat(retired).ino);
            }
            return originalStat.call(this, target, ...rest);
        };
        try {
            assert.throws(() => withLedgerLock(file, () => assert.fail('must not mutate'), { waitMs: 30 }), { code: 'LEDGER_LOCKED' });
            assert.ok(stats >= 2);
            assert.ok(creates >= 2);
            assert.equal(fs.readFileSync(lock, 'utf8'), content);
        } finally {
            fs.statSync = originalStat;
            fs.openSync = originalOpen;
            fs.rmSync(lock, { force: true });
            fs.rmSync(retired, { force: true });
        }
    });
    check('B cannot unlink a live lock acquired by A after B judged the dead lock', () => {
        const lock = file + '.write-lock';
        const originalUnlink = fs.unlinkSync;
        const old = new Date(Date.now() - 11 * 60 * 1000);
        fs.writeFileSync(lock, '');
        fs.utimesSync(lock, old, old);
        let pausedB = false;
        let aEntered = false;
        let overlappingOwner = false;
        let deletedLiveLock = false;
        let aError;
        fs.unlinkSync = function (target, ...rest) {
            if (target !== lock || pausedB) return originalUnlink.call(this, target, ...rest);
            pausedB = true; // B has judged and re-statted L, but has not unlinked it.
            try {
                withLedgerLock(file, () => {
                    aEntered = true; // A reclaimed L and now owns L2.
                    const live = fs.statSync(lock);
                    originalUnlink(lock); // Resume B's already-authorized unlink.
                    deletedLiveLock = !fs.existsSync(lock);
                    withLedgerLock(file, () => { overlappingOwner = true; }, { waitMs: 0 });
                    console.log('CONTROL unsafe B deleted A live inode=' + live.ino);
                }, { waitMs: 20 });
            } catch (e) { aError = e; }
            if (!aEntered) return originalUnlink.call(this, target, ...rest);
        };
        try {
            assert.equal(withLedgerLock(file, () => 'B completed', { waitMs: 1000 }), 'B completed');
            assert.equal(pausedB, true, 'the stat/unlink gap must be exercised');
            assert.equal(deletedLiveLock, false, 'B must never delete A live replacement');
            assert.equal(overlappingOwner, false, 'a third writer must not enter while A owns L2');
            assert.equal(aEntered, false, 'A must be excluded by B reclaim mutex');
            assert.equal(aError?.code, 'LEDGER_LOCKED');
        } finally {
            fs.unlinkSync = originalUnlink;
            fs.rmSync(lock, { force: true });
            fs.rmSync(lock + '.reclaim', { force: true });
        }
    });
    check('a fresh reclaim lock prevents judging or touching the main lock', () => {
        const lock = file + '.write-lock';
        const reclaim = lock + '.reclaim';
        const originalStat = fs.statSync;
        const old = new Date(Date.now() - 11 * 60 * 1000);
        fs.writeFileSync(lock, 'dead ownerless');
        fs.utimesSync(lock, old, old);
        fs.writeFileSync(reclaim, 'other reclaimer');
        const identity = fs.statSync(lock);
        let mainStats = 0;
        fs.statSync = function (target, ...rest) {
            if (target === lock) mainStats++;
            return originalStat.call(this, target, ...rest);
        };
        try {
            assert.throws(() => withLedgerLock(file, () => assert.fail('must not mutate'), { waitMs: 20 }), { code: 'LEDGER_LOCKED' });
            assert.equal(mainStats, 0, 'judgment must occur only under the reclaim mutex');
            assert.equal(originalStat(lock).ino, identity.ino);
            assert.equal(fs.readFileSync(lock, 'utf8'), 'dead ownerless');
            assert.equal(fs.readFileSync(reclaim, 'utf8'), 'other reclaimer');
        } finally {
            fs.statSync = originalStat;
            fs.rmSync(lock, { force: true });
            fs.rmSync(reclaim, { force: true });
        }
    });
    check('a reclaim lock older than 30 seconds is removed before dead-owner reclaim', () => {
        const lock = file + '.write-lock';
        const reclaim = lock + '.reclaim';
        const originalKill = process.kill;
        const originalUnlink = fs.unlinkSync;
        const old = new Date(Date.now() - 31000);
        fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
        fs.writeFileSync(reclaim, 'abandoned reclaimer');
        fs.utimesSync(reclaim, old, old);
        let removed = 0;
        let probedUnderMutex = false;
        process.kill = (pid, signal) => {
            assert.equal(pid, 2147483647);
            assert.equal(signal, 0);
            probedUnderMutex = removed === 1 && fs.existsSync(reclaim);
            throw Object.assign(new Error('dead owner plant'), { code: 'ESRCH' });
        };
        fs.unlinkSync = function (target, ...rest) {
            if (target === reclaim) removed++;
            return originalUnlink.call(this, target, ...rest);
        };
        try {
            assert.equal(withLedgerLock(file, () => 'recovered', { waitMs: 100 }), 'recovered');
            assert.equal(probedUnderMutex, true, 'remove abandoned mutex and reacquire before judging');
            assert.equal(removed, 2, 'abandoned mutex removal plus owned mutex release');
            assert.equal(fs.existsSync(reclaim), false);
        } finally {
            process.kill = originalKill;
            fs.unlinkSync = originalUnlink;
            fs.rmSync(lock, { force: true });
            fs.rmSync(reclaim, { force: true });
        }
    });
    check('reclaim release preserves a mutex replaced with a different identity', () => {
        const lock = file + '.write-lock';
        const reclaim = lock + '.reclaim';
        const retired = reclaim + '.retired';
        const originalKill = process.kill;
        fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
        let replaced = false;
        process.kill = () => {
            fs.renameSync(reclaim, retired);
            fs.writeFileSync(reclaim, 'replacement reclaimer');
            assert.notEqual(fs.statSync(reclaim).ino, fs.statSync(retired).ino);
            replaced = true;
            throw Object.assign(new Error('dead owner plant'), { code: 'ESRCH' });
        };
        try {
            assert.equal(withLedgerLock(file, () => 'recovered', { waitMs: 100 }), 'recovered');
            assert.equal(replaced, true);
            assert.equal(fs.readFileSync(reclaim, 'utf8'), 'replacement reclaimer');
        } finally {
            process.kill = originalKill;
            fs.rmSync(lock, { force: true });
            fs.rmSync(reclaim, { force: true });
            fs.rmSync(retired, { force: true });
        }
    });
    check('lock metadata write failure releases the exclusively created file', () => {
        const originalWrite = fs.writeFileSync;
        fs.writeFileSync = function (target, ...args) {
            if (typeof target === 'number') throw Object.assign(new Error('metadata plant'), { code: 'ENOSPC' });
            return originalWrite.call(this, target, ...args);
        };
        try { assert.throws(() => withLedgerLock(file, () => assert.fail('must not mutate')), /metadata plant/); }
        finally { fs.writeFileSync = originalWrite; }
        assert.ok(!fs.existsSync(file + '.write-lock'));
    });
    check('permanent rename denial preserves old bytes and cleans its temp', () => {
        const before = fs.readFileSync(file, 'utf8');
        let attempts = 0;
        fs.renameSync = () => { attempts++; throw Object.assign(new Error('permanent plant'), { code: 'EPERM' }); };
        try { assert.throws(() => writeAtomic(file, 'replacement'), /permanent plant/); }
        finally { fs.renameSync = originalRename; }
        assert.equal(attempts, 6);
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        assert.deepEqual(fs.readdirSync(root), ['ledger.json']);
    });
    console.log(`${failed ? 'FAIL' : 'PASS'} ${passed}/${passed + failed} ledger lock controls, ${failed} failed`);
    if (failed) process.exitCode = 1;
} finally {
    fs.openSync = originalOpen;
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
}
