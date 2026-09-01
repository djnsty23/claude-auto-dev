#!/usr/bin/env node

// Locks in the two framework-radar winners measured on 2026-09-01. These are
// prose policies, so the regression surface is the policy disappearing or
// reverting to the disproven proxy.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'skills');
const concurrency = fs.readFileSync(path.join(root, 'rule-agent-concurrency', 'SKILL.md'), 'utf8');
const fleet = fs.readFileSync(path.join(root, 'fleet', 'SKILL.md'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}`);
  if (condition) passed++; else failed++;
}

check('requested model is not treated as execution evidence',
  /intent, not execution evidence/.test(concurrency));
check('interactive switches require runtime status readback',
  /read `\/status` after the switch/.test(concurrency));
check('unattended runs require the actual model field',
  /result's actual model field/.test(concurrency));
check('sender success is not treated as delivery evidence',
  /success is acceptance by the transport, not delivery evidence/.test(fleet));
check('duplicate names require the full fresh identity',
  /full `name \[ref\]`/.test(fleet) && /fresh `ListAgents`/.test(fleet));
check('delivery requires recipient-side confirmation',
  /confirm receipt from the target\s+transcript, reply, or resulting branch state/.test(fleet));
check('a stale exact ref blocks the send',
  /exact ref, do not send/.test(fleet));

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
