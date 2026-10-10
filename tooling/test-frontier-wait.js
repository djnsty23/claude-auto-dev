'use strict';
const assert = require('node:assert/strict');
const { waitForState } = require('./frontier-wait.js');

let clock = 0;
const opts = { now: () => clock, pause: ms => { clock += ms; }, pollMs: 10 };
const slow = waitForState(() => clock >= 65000, value => value, [18000, 21000], opts);
assert.equal(slow.elapsedMs, 65000);
assert.equal(slow.value, true);
console.log('PASS completion beyond the former 60 second ceiling is observed under measured slow scheduling');

clock = 0;
const samples = [100, 200, 300];
const late = waitForState(() => ({ state: clock >= 700 ? 'done' : 'running' }),
    value => value.state === 'done', samples, opts);
assert.equal(late.value.state, 'done');
assert.equal(late.elapsedMs, 700);
assert.equal(late.budgetMs, 1200);
console.log('PASS delayed completion is signalled within the measured budget');

clock = 0;
assert.throws(() => waitForState(() => ({ state: 'running', items: [{ state: 'done' }] }),
    value => value.state === 'done', samples, opts), /state.*running/);
assert.equal(clock, 1200);
console.log('PASS missing batch completion fails even when its item is already done');

clock = 0;
assert.throws(() => waitForState(() => null, value => value !== null, samples, opts), /last=null/);
assert.equal(clock, 1200);
assert.throws(() => waitForState(() => null, () => true, [], opts), /measurement/);
console.log('PASS missing data and missing runtime measurements cannot pass');

clock = 0;
const immediate = waitForState(() => ({ state: 'loop-error' }), value => value.state !== 'running', samples, opts);
assert.equal(immediate.elapsedMs, 0);
assert.equal(immediate.value.state, 'loop-error');
console.log('PASS terminal error returns immediately for the caller to grade');

clock = 0;
const boundary = waitForState(() => clock >= 1200, value => value, samples, opts);
assert.equal(boundary.elapsedMs, 1200);
console.log('PASS the final deadline sample observes a completion already written');
