#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const HOOK = path.resolve(__dirname, '..', 'plugins/autodev-core/hooks/user-prompt-image-scan.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-records-'));
const env = { ...process.env, CLAUDE_PLUGIN_OPTION_IMAGE_SCAN: 'true' };
const image = n => ({ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(n) } }] });
const text = { role: 'user', content: [{ type: 'text', text: 'current question' }] };
let cases = 0;
let helperCases = 0;
function check(name, rows, expected, suffix = '') {
  const file = path.join(tmp, name + '.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n' + suffix);
  const started = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ transcript_path: file, cwd: tmp }), encoding: 'utf8', env, windowsHide: true, timeout: 10000 });
  assert.equal(r.error, undefined, name + ' completed inside 10 seconds');
  assert.ok(Date.now() - started < 10000, name + ' wall budget');
  assert.equal(r.status, 0, name + ' exit');
  assert.equal(r.stderr, '', name + ' stderr silent');
  if (expected) {
    assert.notEqual(r.stdout, '', name + ' image context present');
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /An image is attached/);
  } else assert.equal(r.stdout, '', name + ' stdout silent');
  console.log('PASS ' + name + ' (' + (Date.now() - started) + ' ms)');
  cases++;
  return file;
}
function fiftyMiB(name, current, expected) {
  const last = JSON.stringify(current);
  const prefix = JSON.stringify({ role: 'assistant', content: '' });
  const padding = 50 * 1024 * 1024 - Buffer.byteLength(last) - Buffer.byteLength(prefix) - 2;
  const file = check(name, [{ role: 'assistant', content: 'x'.repeat(padding) }, current], expected);
  assert.equal(fs.statSync(file).size, 50 * 1024 * 1024, 'exact 50 MiB transcript population');
  return file;
}
function linearWork(file) {
  const source = fs.readFileSync(HOOK, 'utf8');
  const start = source.indexOf('function latestUserMessage(');
  const end = source.indexOf('// --- Read stdin', start);
  let readBytes = 0, concatBytes = 0, visitedBytes = 0;
  const measuredFs = Object.create(fs);
  measuredFs.readSync = (...args) => { const n = fs.readSync(...args); readBytes += n; return n; };
  const instrument = b => {
    b.lastIndexOf = function(value, at) {
      const found = Buffer.prototype.lastIndexOf.call(this, value, at);
      visitedBytes += (at === undefined ? this.length - 1 : at) - found;
      return found;
    };
    return b;
  };
  const measuredBuffer = {
    alloc(n) { return instrument(Buffer.alloc(n)); },
    concat(parts) {
      concatBytes += parts.reduce((n, b) => n + b.length, 0);
      return instrument(Buffer.concat(parts));
    },
  };
  const context = vm.createContext({ fs: measuredFs, Buffer: measuredBuffer, timeLeft: () => 1 });
  vm.runInContext(source.slice(start, end) + '\nthis.scan = latestUserMessage;', context);
  assert.equal(context.scan(file)?.role, 'user', 'work control reaches current user');
  assert.ok(readBytes <= 16 * 1024 * 1024, 'scan read cap');
  // Evaluate both bounds even when one fails, so the mutation records prove
  // each canary independently rather than stopping at the first assertion.
  const errors = [];
  try { assert.ok(concatBytes <= readBytes, `linear record assembly copied ${concatBytes} bytes for ${readBytes} read`); }
  catch (e) { errors.push(e); }
  try { assert.ok(visitedBytes <= readBytes, `delimiter visits ${visitedBytes} bounded by ${readBytes} read`); }
  catch (e) { errors.push(e); }
  if (errors.length) throw new AggregateError(errors, 'linear assembly and delimiter work bounds');
  console.log(`PASS linear work: ${readBytes} read, ${concatBytes} copied, ${visitedBytes} delimiter visits`);
  helperCases++;
}
function postParseDeadline(file) {
  const source = fs.readFileSync(HOOK, 'utf8');
  const start = source.indexOf('function latestUserMessage(');
  const end = source.indexOf('// --- Read stdin', start);
  let expired = false;
  const context = vm.createContext({ fs, Buffer, timeLeft: () => expired ? 0 : 1,
    JSON: { parse(line) { const record = JSON.parse(line); expired = true; return record; } } });
  vm.runInContext(source.slice(start, end) + '\nthis.scan = latestUserMessage;', context);
  assert.equal(context.scan(file) === null, true, 'budget exhausted during parse cannot return image context');
  assert.equal(expired, true, 'deadline test reached real JSON parsing');
  console.log('PASS expired post-parse budget returns no record');
  helperCases++;
}
try {
  if (process.argv.includes('--work-only')) {
    const file = path.join(tmp, 'work-only.jsonl');
    fs.writeFileSync(file, JSON.stringify({ role: 'assistant', content: 'x'.repeat(35 * 1024 * 1024 - 200) })
      + '\n' + JSON.stringify(image(15 * 1024 * 1024)) + '\n');
    linearWork(file);
  } else {
  check('small-positive', [image(4)], true);
  check('large-current-row', [text, image(256 * 1024)], true);
  check('multi-megabyte-current-row', [text, image(2 * 1024 * 1024)], true);
  check('large-assistant-tail', [image(4), { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] }], true);
  check('newest-array-text-wins', [image(256 * 1024), text], false);
  check('newest-string-text-wins', [image(4), { role: 'user', content: 'current plain text' }], false);
  check('unicode-chunk-boundary', [image(256 * 1024), { role: 'assistant', content: [{ type: 'text', text: '\u754c'.repeat(50000) }] }], true);
  check('truncated-final-row', [image(256 * 1024)], true, '{"role":');
  check('scan-byte-limit', [image(4), { role: 'assistant', content: 'x'.repeat(17 * 1024 * 1024) }], false);
  fiftyMiB('50MiB-current-12MiB-image', image(12 * 1024 * 1024), true);
  const nearCap = fiftyMiB('50MiB-current-15MiB-image', image(15 * 1024 * 1024), true);
  fiftyMiB('50MiB-current-15MiB-text', { role: 'user', content: 'x'.repeat(15 * 1024 * 1024) }, false);
  linearWork(nearCap);
  postParseDeadline(nearCap);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(cases + ' image record cases passed through real hook subprocesses, plus ' + helperCases + ' helper controls');
