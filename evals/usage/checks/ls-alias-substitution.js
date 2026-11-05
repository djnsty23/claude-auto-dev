'use strict';
// Case ls-alias-substitution: a script path picked with `$(ls ...)` gets a
// trailing `*` and node cannot find it.
//
// The failure (usage-mine class tool-error/shell-fault, its largest shape since
// 2026-10-08: 523 of 826 events, node MODULE_NOT_FOUND): the Bash tool loads the
// user's profile, where `ls` is aliased to `ls -F`, which marks an executable
// with `*`. So `W=$(ls -d <cache>/*/scripts/unattended-worker.js | sort -V | tail -1)`
// yields `...unattended-worker.js*`, and `node "$W" ready` fails. 458 of the 523
// also handed node an MSYS `/c/Users/...` path.
//
// The check asks the Bash decision module of the tree under test
// (hooks/fn/bash-rules.mjs decideBash) about the paraphrased command, and a
// control: a plain `ls -la` must pass untouched, so a rule that refuses every ls
// is not a pass.
//
// PASS: the substitution is refused with a reason, or rewritten so no bare
// `$(ls` remains; and the control is neither refused nor rewritten.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SUBJECT = 'W=$(ls -d ~/.claude/plugins/cache/autodev/autodev-core/*/scripts/unattended-worker.js | sort -V | tail -1); node "$W" ready';
const CONTROL = 'ls -la plugins/autodev-core/scripts';

async function check({ repo }) {
    const mod = path.join(repo, 'plugins', 'autodev-core', 'hooks', 'fn', 'bash-rules.mjs');
    if (!fs.existsSync(mod)) return { pass: false, indeterminate: true, detail: `no bash-rules.mjs under ${repo}` };
    const { decideBash } = await import(pathToFileURL(mod).href);
    if (typeof decideBash !== 'function') return { pass: false, indeterminate: true, detail: 'bash-rules.mjs exports no decideBash' };
    const cwd = 'C:/Users/someone/project';
    const repoInfo = { root: cwd, remote: '' };
    const s = decideBash({ command: SUBJECT, cwd, repo: repoInfo });
    const c = decideBash({ command: CONTROL, cwd, repo: repoInfo });
    const controlTouched = !!c.deny || (typeof c.command === 'string' && c.command !== CONTROL);
    if (controlTouched) return { pass: false, detail: `the control \`${CONTROL}\` was ${c.deny ? 'refused' : 'rewritten'}: a rule on every ls is not the fix` };
    if (s.deny) return { pass: true, detail: `refused (${s.rule}): ${String(s.deny).slice(0, 120)}` };
    if (typeof s.command === 'string' && !/\$\(\s*ls\b/.test(s.command)) return { pass: true, detail: `rewritten to: ${s.command.slice(0, 120)}` };
    return { pass: false, detail: 'decideBash lets `$(ls -d ...)` through unchanged, so the profile alias appends `*` to the path node is given' };
}

module.exports = { check, SUBJECT, CONTROL };
