#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const HOOK = path.resolve(__dirname, '..', 'plugins/autodev-core/hooks/user-prompt-image-scan.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-records-'));
const env = { ...process.env, CLAUDE_PLUGIN_OPTION_IMAGE_SCAN: 'true' };
const image = n => ({ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(n) } }] });
const text = { role: 'user', content: [{ type: 'text', text: 'current question' }] };
let cases = 0;
function check(name, rows, expected, suffix = '') {
  const file = path.join(tmp, name + '.jsonl');
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n' + suffix);
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ transcript_path: file, cwd: tmp }), encoding: 'utf8', env, windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 0, name + ' exit');
  assert.equal(r.stderr, '', name + ' stderr silent');
  if (expected) {
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /An image is attached/);
  } else assert.equal(r.stdout, '', name + ' stdout silent');
  console.log('PASS ' + name);
  cases++;
}
try {
  check('small-positive', [image(4)], true);
  check('large-current-row', [text, image(256 * 1024)], true);
  check('multi-megabyte-current-row', [text, image(2 * 1024 * 1024)], true);
  check('large-assistant-tail', [image(4), { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] }], true);
  check('newest-array-text-wins', [image(256 * 1024), text], false);
  check('newest-string-text-wins', [image(4), { role: 'user', content: 'current plain text' }], false);
  check('unicode-chunk-boundary', [image(256 * 1024), { role: 'assistant', content: [{ type: 'text', text: '\u754c'.repeat(50000) }] }], true);
  check('truncated-final-row', [image(256 * 1024)], true, '{"role":');
  check('scan-byte-limit', [image(4), { role: 'assistant', content: 'x'.repeat(17 * 1024 * 1024) }], false);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(cases + ' image record cases passed through the real hook subprocess');
