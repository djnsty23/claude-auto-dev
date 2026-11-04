#!/usr/bin/env node
'use strict';
// Tests for evals/qwen/run.js: the edit-block parser and applier that turn a
// Qwen answer into file edits, the manifest's shape, and the CLI's --help.
// No model is called and no worktree is made.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SUBJECT = path.join(ROOT, 'evals', 'qwen', 'run.js');
const { parseBlocks, applyBlocks, parseArgs, parseFixLines, scrub } = require(SUBJECT);

let pass = 0, fail = 0;
function check(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : '  (' + detail + ')'}`);
}

const block = (file, search, replace) => `### FILE: ${file}\n@@ SEARCH\n${search}@@ REPLACE\n${replace}@@ END\n`;

// parseBlocks
const two = parseBlocks('prose first\n' + block('a.js', 'x = 1\n', 'x = 2\n') + '\nmore prose\n' + block('`b/c.ts`', '', 'new\n'));
check('two blocks parse, prose around them ignored', two.length === 2, JSON.stringify(two));
check('the path loses wrapping backticks', two[1] && two[1].file === 'b/c.ts', two[1] && two[1].file);
check('an empty SEARCH parses as empty', two[1] && two[1].search === '');
check('an answer with no blocks parses to none', parseBlocks('```js\nconst a = 1\n```').length === 0);

// applyBlocks
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-eval-test-'));
try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\nconst y = 2;\n');
    let errs = applyBlocks(dir, parseBlocks(block('a.js', 'const y = 2;\n', 'const y = 3;\n')));
    check('an exact SEARCH is replaced', errs.length === 0 && fs.readFileSync(path.join(dir, 'a.js'), 'utf8') === 'const x = 1;\nconst y = 3;\n', errs.join());

    fs.writeFileSync(path.join(dir, 'crlf.js'), 'a\r\nb\r\n');
    errs = applyBlocks(dir, parseBlocks(block('crlf.js', 'b\n', 'c\n')));
    check('a CRLF file keeps CRLF after an LF block', errs.length === 0 && fs.readFileSync(path.join(dir, 'crlf.js'), 'utf8') === 'a\r\nc\r\n', JSON.stringify(fs.readFileSync(path.join(dir, 'crlf.js'), 'utf8')));

    fs.writeFileSync(path.join(dir, 'ws.js'), 'foo();   \nbar();\n');
    errs = applyBlocks(dir, parseBlocks(block('ws.js', 'foo();\nbar();\n', 'baz();\n')));
    check('trailing-whitespace drift still matches', errs.length === 0 && fs.readFileSync(path.join(dir, 'ws.js'), 'utf8') === 'baz();\n', errs.join());

    errs = applyBlocks(dir, parseBlocks(block('a.js', 'nope\n', 'x\n')));
    check('a SEARCH that is not in the file is an error, file unchanged', errs.length === 1 && /not found/.test(errs[0]) && fs.readFileSync(path.join(dir, 'a.js'), 'utf8').includes('const y = 3;'));

    errs = applyBlocks(dir, parseBlocks(block('missing.js', 'a\n', 'b\n')));
    check('editing a missing file is an error', errs.length === 1 && /does not exist/.test(errs[0]));

    errs = applyBlocks(dir, parseBlocks(block('new/dir/n.js', '', 'export {};\n')));
    check('an empty SEARCH creates the file', errs.length === 0 && fs.readFileSync(path.join(dir, 'new', 'dir', 'n.js'), 'utf8') === 'export {};\n');

    errs = applyBlocks(dir, parseBlocks(block('../escape.js', '', 'x\n')));
    check('a path outside the worktree is refused', errs.length === 1 && !fs.existsSync(path.join(dir, '..', 'escape.js')), errs.join());
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

// parseFixLines
const fx = parseFixLines('Reviewed.\nFIX: NEW | exported name differs from the brief | runErr instead of runError\n- **FIX: Q2 | kept a dead branch | if (false) {...}**\nFIX: none\n');
check('FIX lines parse into code, rule and example; FIX: none is skipped', fx.length === 2 && fx[0].code === 'NEW' && fx[0].example === 'runErr instead of runError' && fx[1].code === 'Q2', JSON.stringify(fx));
check('an answer saying FIX: none yields no fixes', parseFixLines('All good.\nFIX: none').length === 0);

// scrub: a results row never carries the home directory, in any spelling.
const home = os.homedir();
const row = JSON.stringify({ tail: `at ${home}${path.sep}x.js and ${home.replace(/\\/g, '/')}/y.js` });
const scrubbed = scrub(row);
check('scrub removes the home directory from a results row', !scrubbed.includes(home.replace(/\\/g, '/')) && !scrubbed.includes(JSON.stringify(home).slice(1, -1)) && scrubbed.includes('~'), scrubbed);

// parseArgs
const a = parseArgs(['run', '--arm', 'c', '--task', 'x', '--task', 'y', '--keep']);
check('repeated --task collects, flags are booleans', a._[0] === 'run' && a.arm === 'c' && a.task.join() === 'x,y' && a.keep === true);

// manifest shape
const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals', 'qwen', 'manifest.json'), 'utf8'));
const bad = m.tasks.filter((t) => !(t.id && t.repo && /^[0-9a-f]{40}$/.test(t.parent) && /^[0-9a-f]{40}$/.test(t.fix)
    && t.brief && t.brief.length > 40 && t.subject && t.files.length && t.tests.length && t.accept && t.passLine));
check(`every manifest task carries repo, SHAs, brief, files, tests, acceptance and pass line (${m.tasks.length} tasks)`, bad.length === 0 && m.tasks.length >= 5, bad.map((t) => t.id).join());
// This repo is public: tasks from private repos live in a private data dir (--data).
check('the public manifest holds only this repo\'s tasks', m.tasks.every((t) => t.repo === 'claude-auto-dev'), m.tasks.map((t) => t.repo).join());
// [measured 2026-11-04] cmd.exe ate the caret in `<sha>^`, so every parent equalled its fix.
check('no task starts at its own fix commit', m.tasks.every((t) => t.parent !== t.fix), m.tasks.filter((t) => t.parent === t.fix).map((t) => t.id).join());
check('task ids are unique', new Set(m.tasks.map((t) => t.id)).size === m.tasks.length);
check('every pass line is a valid regex', m.tasks.every((t) => { try { new RegExp(t.passLine, 'm'); return true; } catch { return false; } }));
check('no task acceptance touches secrets, payments or prod data', !m.tasks.some((t) => /stripe|checkout|doppler|\.env|supabase db|migration/i.test(t.accept + t.files.join(' '))));

// CLI
const help = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8' });
check('--help prints usage and exits 0', help.status === 0 && /^usage: node evals\/qwen\/run\.js/.test(help.stdout), help.stderr);

console.log(`\n${pass} passed, ${fail} failed, ${pass + fail} checks`);
process.exitCode = fail ? 1 : 0;
