#!/usr/bin/env node
/**
 * race-interleave.js: puts a concurrent write exactly inside a hook's window.
 *
 * A lost-update race needs another writer to land between the hook's read and
 * its write. Twenty real processes hit that window only sometimes, so a suite
 * built on them alone passes on a lucky run. This preload makes the other
 * writer deterministic: after the hook's own fs call on a named file returns,
 * it appends a line to that file, as a peer session would.
 *
 * A suite runs the hook as `node --require <preload> <hook>` with RACE_SPEC in
 * the environment:
 *
 *   { "rules": [ { "op": "readFileSync", "basename": "x.jsonl",
 *                  "prefix": false, "appendTo": "<abs path>",
 *                  "text": "one line\n", "times": 1 } ],
 *     "record": "<abs path of a file listing what was planted>" }
 *
 * `op` is any sync fs function taking the path first. `prefix: true` matches
 * every basename that starts with `basename`. Each planted line is also
 * appended to `record`, so the suite asserts on what was actually planted and a
 * rule that never fired reads as zero plants, not as a pass.
 *
 * Usage (from a suite): const { preloadPath, spec } = require('./race-interleave.js')
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const PRELOAD = `'use strict';
const fs = require('fs');
const path = require('path');
let spec = {};
try { spec = JSON.parse(process.env.RACE_SPEC || '{}'); } catch { spec = {}; }
const append = fs.appendFileSync;
for (const rule of spec.rules || []) {
    const orig = fs[rule.op];
    if (typeof orig !== 'function') continue;
    let left = rule.times || 1;
    fs[rule.op] = function (p, ...rest) {
        const out = orig.call(this, p, ...rest);
        const base = typeof p === 'string' ? path.basename(p) : '';
        const hit = rule.prefix ? base.startsWith(rule.basename) : base === rule.basename;
        if (hit && left > 0) {
            left--;
            append(rule.appendTo, rule.text);
            if (spec.record) append(spec.record, rule.text.endsWith('\\n') ? rule.text : rule.text + '\\n');
        }
        return out;
    };
}
`;

/** Writes the preload into a fresh temp dir and returns its path. */
function preloadPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-preload-'));
    const file = path.join(dir, 'race-preload.js');
    fs.writeFileSync(file, PRELOAD);
    return file;
}

/** The env value for RACE_SPEC. */
const spec = (rules, record) => JSON.stringify({ rules, record });

/** The lines a run actually planted, from its record file. */
function planted(record) {
    try { return fs.readFileSync(record, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

module.exports = { preloadPath, spec, planted };

if (require.main === module) {
    console.log('race-interleave.js: a --require preload for suites. It has no CLI. See the header.');
}
