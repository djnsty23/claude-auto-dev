#!/usr/bin/env node
'use strict';
// The module-kit scaffold commands the skills print are copied with real paths
// substituted. Unquoted, a parent such as `C:\Users\a b\code` splits into two
// argv words and the site lands in a truncated parent `[measured 2026-10-30]`.
// Every kit command in the shipped docs quotes its kit path and its --into parent.
const fs = require('fs');
const path = require('path');
const repo = path.resolve(__dirname, '..');
const DOCS = [
    'plugins/autodev-core/skills/setup-project/SKILL.md',
    'plugins/autodev-core/skills/spec/references/new-app-chain.md',
];
let total = 0; let failed = 0;
function check(name, ok, detail = '') { total++; if (!ok) failed++; console.log(`${ok ? 'ok' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`); }

const commands = [];
for (const rel of DOCS) {
    const text = fs.readFileSync(path.join(repo, rel), 'utf8');
    for (const m of text.matchAll(/node\s+(\S+?(?:new-site|install-module)\.mjs"?)[^\n`]*/g)) commands.push({ rel, line: m[0], script: m[1] });
}
// Population: both docs carry new-site.mjs, and the chain doc install-module.mjs.
check('the population holds every kit command (3 in 2 docs)', commands.length === 3 && new Set(commands.map((c) => c.rel)).size === 2,
    commands.map((c) => `${c.rel}: ${c.line}`).join(' | '));
for (const c of commands) {
    check(`A10. ${path.basename(c.rel)}: the kit path is quoted in \`${c.line}\``, /^"<kit>\/scripts\/[\w-]+\.mjs"$/.test(c.script), c.script);
    const into = /--into\s+(\S+)/.exec(c.line);
    if (into) check(`A10. ${path.basename(c.rel)}: the --into parent is quoted in \`${c.line}\``, /^"<parent>"$/.test(into[1]), into[1]);
}
console.log(`scaffold-command-quoting: ${total} checks, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
