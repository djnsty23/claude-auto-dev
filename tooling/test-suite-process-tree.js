#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const SUBJECT = path.join(__dirname, 'suite-process-tree.js');
const source = fs.readFileSync(SUBJECT, 'utf8');
const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

// Run the shipped supervisor, replacing only OS process tables, signals, and
// time. Virtual time makes the full retry budget test deterministic under load.
function harness(platform, initial, options = {}) {
  let now = 100000, serial = 0, snapshots = 0;
  const timers = new Map(), rows = new Map(initial.map(row => [row.pid, { ...row }]));
  const signals = [], delays = [];
  const FakeDate = class extends Date { static now() { return now; } };
  const context = vm.createContext({ module: { exports: {} }, Buffer, Date: FakeDate,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: now + ms }); delays.push(ms); return id; },
    clearTimeout(id) { timers.delete(id); },
    process: { platform, pid: 900000, env: {}, kill(pid, signal) {
      signals.push({ pid, signal });
      if (options.onKill) options.onKill(pid, rows);
      else rows.delete(pid);
    } },
    require(name) {
      assert.equal(name, 'node:child_process');
      return { spawn() {
        const index = ++snapshots;
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { setImmediate(() => child.emit('close', null)); };
        if (options.hang === 'all' || options.hang === index) return child;
        setImmediate(() => {
          if (options.beforeSnapshot) options.beforeSnapshot(index, rows);
          const table = [...rows.values(), { pid: 900000, parent: 0, born: 1000 }];
          child.stdout.emit('data', table.map(row => platform === 'win32'
            ? `${row.pid} ${row.parent} ${row.born}`
            : `${row.pid} ${row.parent} S ${new Date(row.born).toUTCString()}`).join('\n'));
          child.emit('close', 0);
        });
        return child;
      } };
    },
  });
  vm.runInContext(source + '\nmodule.exports.remember = remember;', context, { filename: SUBJECT });
  async function advance(ms) {
    const target = now + ms;
    await flush();
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, t] = next;
      timers.delete(id); now = t.at; t.fn(); await flush();
    }
    now = Math.max(now, target); await flush();
  }
  async function settle(promise) {
    let done = false, error;
    promise.then(() => { done = true; }, e => { done = true; error = e; });
    for (let i = 0; !done && i < 100; i++) await advance(100);
    assert.ok(done, 'cleanup settled within 10000 virtual milliseconds');
    if (error) throw error;
  }
  return { api: context.module.exports, rows, signals, delays, advance, settle,
    snapshots: () => snapshots, now: () => now };
}
const table = [
  { pid: 100001, parent: 0, born: 90000 },
  { pid: 100002, parent: 100001, born: 91000 },
  { pid: 100003, parent: 100002, born: 92000 },
  { pid: 100004, parent: 0, born: 93000 },
];
const cases = {
  async F1() {
    const h = harness('win32', table, { hang: 1 });
    const tree = h.api.trackTree(100001, 90000);
    const start = h.now();
    try { await h.settle(tree.terminate()); } finally { tree.stop(); }
    assert.ok(h.snapshots() >= 3, 'timed-out snapshot retried and cleanup verified');
    assert.ok(h.signals.some(row => row.pid === 100003), 'retry kills known grandchild');
    assert.ok(h.rows.has(100004), 'unrelated PID survives retry');
    assert.ok(h.now() - start <= 7000, 'retry stays inside total cleanup budget');
    const down = harness('win32', table, { hang: 'all' });
    const blocked = down.api.trackTree(100001, 90000);
    const began = down.now();
    await assert.rejects(down.settle(blocked.terminate()), /snapshot|7000/);
    blocked.stop();
    assert.ok(down.snapshots() >= 2, 'persistent snapshot failure is retried');
    assert.ok(down.now() - began <= 7000, 'persistent failure cannot exceed cleanup budget');
    assert.equal(down.signals.length, 0, 'no unverifiable PID is signalled');
  },
  async F2() {
    const h = harness('win32', []);
    const owned = new Map();
    const remember = h.api.remember;
    remember(table, owned, 100001, 90000, Infinity, 100000);
    const known = { pid: 100005, parent: 100002, born: 99000 };
    const stranger = { pid: 100006, parent: 100002, born: 100001 };
    remember([table[0], known, stranger], owned, 100001, 90000, Infinity, 101000);
    assert.ok(owned.has(known.pid), 'child born before dead parent last seen is retained');
    assert.ok(!owned.has(stranger.pid), 'dead parent refuses child born after last seen alive');
    const reused = { pid: 100002, parent: 0, born: 102000 };
    const other = { pid: 100007, parent: 100002, born: 103000 };
    remember([table[0], reused, other], owned, 100001, 90000, Infinity, 104000);
    assert.ok(!owned.has(other.pid), 'live replacement parent is never trusted');
    const rootOwned = new Map();
    remember(table, rootOwned, 100001, 90000, Infinity, 100000);
    const replacedRoot = { pid: 100001, parent: 0, born: 102000 };
    const peerChild = { pid: 100008, parent: 100001, born: 103000 };
    remember([replacedRoot, peerChild], rootOwned, 100001, 90000, Infinity, 104000);
    assert.ok(!rootOwned.has(peerChild.pid), 'root PID replacement before exit event never recruits a peer child');
  },
  async F3() {
    const h = harness('linux', table);
    const tree = h.api.trackTree(100001, 90000);
    await h.advance(4999);
    assert.ok(h.snapshots() <= 5, `normal 5 s path uses at most 5 snapshots, got ${h.snapshots()}`);
    assert.ok(h.snapshots() >= 1, 'ancestry positive control was observed');
    // Both intermediate and root exit before cleanup. The detached leaf is
    // reparented to init, so a deadline-only scan cannot discover its ancestry.
    h.rows.delete(100001); h.rows.delete(100002);
    h.rows.get(100003).parent = 1;
    tree.exited();
    try { await h.settle(tree.terminate()); } finally { tree.stop(); }
    assert.ok(h.signals.some(row => row.pid === 100003), 'remembered reparented detached grandchild is killed');
    assert.ok(h.rows.has(100004), 'reparented cleanup leaves unrelated PID alive');
  },
  async F4() {
    let deadlineFired = false;
    const h = harness('win32', table, { beforeSnapshot(index, rows) {
      if (deadlineFired) rows.delete(100001);
    } });
    const tree = h.api.trackTree(100001, 90000);
    await flush();
    deadlineFired = true;
    // OS exit precedes delivery of ChildProcess's exit event. Keep exitedAt
    // infinite while the timeout snapshot sees only the known descendants.
    try { await h.settle(tree.terminate()); } finally { tree.stop(); }
    assert.ok(h.signals.some(row => row.pid === 100002), 'root disappearance still kills known child');
    assert.ok(h.signals.some(row => row.pid === 100003), 'root disappearance still kills known grandchild');
    assert.ok(h.rows.has(100004), 'exit race never kills unrelated PID');
  },
  async F6() {
    const runner = fs.readFileSync(path.join(__dirname, 'test-all.js'), 'utf8');
    const start = runner.indexOf('function classify(res)');
    const end = runner.indexOf('// One suite,', start);
    const context = vm.createContext({});
    vm.runInContext(runner.slice(start, end) + '\nthis.subject = classify;', context);
    const result = context.subject({ status: 0, error: { code: 'EPROCESS_TREE' } });
    assert.equal(result.state, 'indet', 'cleanup failure never passes');
    assert.match(result.reason, /suite exited 0.*cleanup failed/i, 'report completed execution and failed cleanup');
    assert.doesNotMatch(result.reason, /DID NOT RUN/);
    assert.match(context.subject({ error: { code: 'ENOENT' } }).reason, /DID NOT RUN/);
  },
};
(async () => {
  let failures = 0;
  for (const [name, run] of Object.entries(cases)) {
    if (selected && name !== selected) continue;
    try { await run(); console.log('PASS ' + name); }
    catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.stack); }
  }
  assert.ok(!selected || Object.hasOwn(cases, selected), 'requested regression exists');
  process.exitCode = failures ? 1 : 0;
})();
