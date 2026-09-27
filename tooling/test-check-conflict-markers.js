#!/usr/bin/env node
// Suite for tooling/check-conflict-markers.js, driven as a subprocess against
// throwaway git repositories. The planted defect is the incident's own shape:
// markers committed inside a template literal, where they still parse. A clean
// repository full of near-misses is the control, and a directory git refuses is
// the indeterminate case.
//
// Every marker in this file is built with repeat(), so this suite never carries
// a marker line of its own and the real-repo case below can grade it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CHECK = path.join(__dirname, 'check-conflict-markers.js');
const cases = [];
const check = (label, ok, why) => cases.push([label, ok, why]);
const run = (args, env) => spawnSync(process.execPath, [CHECK, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, env: env || process.env,
});
const detail = (r) => `status=${r.status} signal=${r.signal} stdout=${JSON.stringify(String(r.stdout).slice(0, 400))} stderr=${JSON.stringify(String(r.stderr).slice(0, 300))}`;

const OURS = '<'.repeat(7) + ' HEAD';
const MID = '='.repeat(7);
const THEIRS = '>'.repeat(7) + ' origin/main';
const FENCE = '`'.repeat(3);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conflictmarkers-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left in tmp */ } });

// No test repository may resolve to a repository above the temp dir.
const ENV = { ...process.env, GIT_CEILING_DIRECTORIES: tmp };
const git = (cwd, args) => spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, env: ENV });

/** A git repository holding `files`, all staged. `untracked` are written and never added. */
let repos = 0;
const repo = (name, files, untracked = {}) => {
    repos++;
    const root = path.join(tmp, name);
    fs.mkdirSync(root, { recursive: true });
    const init = git(root, ['init', '-q']);
    if (init.status !== 0) throw new Error(`git init failed in ${root}: ${init.stderr}`);
    const write = (set) => {
        for (const [f, body] of Object.entries(set)) {
            fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
            fs.writeFileSync(path.join(root, f), body);
        }
    };
    write(files);
    if (Object.keys(files).length) {
        const add = git(root, ['add', '--', ...Object.keys(files)]);
        if (add.status !== 0) throw new Error(`git add failed in ${root}: ${add.stderr}`);
    }
    write(untracked);
    return root;
};

// Control: a clean repository of near-misses. Each line here is what a naive
// detector would flag and git never writes as a marker.
const clean = run(['--root', repo('clean', {
    'a.js': "'use strict';\nmodule.exports = 1;\n",
    'near.txt': [
        '='.repeat(8),                   // eight, not seven
        '<'.repeat(6) + ' six',           // six
        '  ' + OURS,                      // indented
        'x ' + THEIRS,                    // not at the start of the line
        MID + 'x',                        // no space or end of line after it
        '>'.repeat(7) + '>' + ' eight',   // eight
    ].join('\n') + '\n',
    // A doc showing a conflict inside a balanced fence: the deliberate exemption.
    'docs/howto.md': ['# Resolving', '', FENCE + 'text', OURS, 'a', MID, 'b', THEIRS, FENCE, '', 'Done.'].join('\n') + '\n',
    'docs/tilde.md': ['~~~~', OURS, '~~~', 'still fenced: three tildes do not close four', MID, '~~~~', ''].join('\n'),
    // A marker in a binary file is not text and is not graded.
    'blob.bin': Buffer.concat([Buffer.from(OURS + '\n'), Buffer.from([0, 1, 2])]),
}, {
    // Untracked is outside the population.
    'scratch.js': OURS + '\n',
})], ENV);
check('a clean repository exits 0', clean.status === 0 && clean.signal === null, detail(clean));
check('  and prints the population it read (5 tracked, 4 as text, 1 binary)',
    /5 tracked file\(s\), 4 scanned as text, skipped 1 binary/.test(clean.stdout) && /0 marker line\(s\)/.test(clean.stdout), detail(clean));
check('  and does not grade the untracked file', !/scratch\.js/.test(clean.stdout), detail(clean));

// The planted defect: the incident's shape, markers inside a template literal.
// It parses, which is why node --check and the suites stayed green.
const planted = repo('planted', {
    'plugins/core/scripts/gate.js': [
        "'use strict';",
        'const USAGE = `usage: gate [--root DIR]',
        OURS,
        '  --meta-csp   grade a meta CSP',
        MID,
        '  --url URL    grade a live host',
        THEIRS,
        '`;',
        'module.exports = USAGE;',
    ].join('\n') + '\n',
    'ok.js': 'module.exports = 2;\n',
});
const parses = spawnSync(process.execPath, ['--check', path.join(planted, 'plugins/core/scripts/gate.js')], { encoding: 'utf8', windowsHide: true });
check('the planted file parses, so node --check cannot see it', parses.status === 0, `status=${parses.status} ${parses.stderr}`);
const red = run(['--root', planted], ENV);
check('markers in a template literal exit 1', red.status === 1 && red.signal === null, detail(red));
check('  and name file:line for each of the three',
    /\[FAIL\] plugins\/core\/scripts\/gate\.js:3: </.test(red.stdout)
    && /\[FAIL\] plugins\/core\/scripts\/gate\.js:5: =/.test(red.stdout)
    && /\[FAIL\] plugins\/core\/scripts\/gate\.js:7: >/.test(red.stdout), detail(red));
check('  and count them in the summary', /2 tracked file\(s\), 2 scanned as text, 0 unreadable, 3 marker line\(s\)/.test(red.stdout), detail(red));

// Each marker alone fires. A resolving script that failed half-way can leave
// any one of them behind.
for (const [label, line] of [['ours', OURS], ['separator', MID], ['theirs', THEIRS], ['bare ours', '<'.repeat(7)]]) {
    const r = run(['--root', repo(`alone-${label.replace(' ', '-')}`, { 'f.txt': `before\n${line}\nafter\n` })], ENV);
    check(`a lone ${label} marker fires at f.txt:2`, r.status === 1 && /\[FAIL\] f\.txt:2:/.test(r.stdout), detail(r));
}

// CRLF: a Windows checkout reads the same as an LF one.
const crlf = run(['--root', repo('crlf', { 'w.txt': `one\r\n${MID}\r\ntwo\r\n` })], ENV);
check('a separator followed by CRLF fires', crlf.status === 1 && /\[FAIL\] w\.txt:2:/.test(crlf.stdout), detail(crlf));

// Markdown: the exemption is the fence, not the file type.
const mdOut = run(['--root', repo('md-outside', { 'README.md': ['# Title', '', OURS, 'mine', MID, 'theirs', THEIRS, ''].join('\n') })], ENV);
check('markdown markers outside a fence fire', mdOut.status === 1 && /README\.md:3:/.test(mdOut.stdout) && /README\.md:7:/.test(mdOut.stdout), detail(mdOut));
const setext = run(['--root', repo('md-setext', { 'h.md': 'Heading\n' + MID + '\n' })], ENV);
check('a setext underline of exactly seven = fires (use an ATX heading)', setext.status === 1 && /h\.md:2:/.test(setext.stdout), detail(setext));
const unclosed = run(['--root', repo('md-unclosed', { 'u.md': ['intro', FENCE, OURS, 'x', MID, 'y', THEIRS, ''].join('\n') })], ENV);
check('an unclosed fence voids the exemption: every marker fires',
    unclosed.status === 1 && /u\.md:3:/.test(unclosed.stdout) && /u\.md:5:/.test(unclosed.stdout) && /u\.md:7:/.test(unclosed.stdout), detail(unclosed));
const notMd = run(['--root', repo('fence-in-js', { 'f.js': ['/*', FENCE, OURS, FENCE, '*/', ''].join('\n') })], ENV);
check('a fence in a non-markdown file exempts nothing', notMd.status === 1 && /f\.js:3:/.test(notMd.stdout), detail(notMd));

// A tracked file deleted from the working tree is counted, not graded.
const gone = repo('deleted', { 'keep.txt': 'k\n', 'gone.txt': OURS + '\n' });
fs.rmSync(path.join(gone, 'gone.txt'));
const del = run(['--root', gone], ENV);
check('a tracked file missing from the working tree is counted as missing', del.status === 0 && /skipped 1 missing/.test(del.stdout), detail(del));

// No verdict: git refuses, git is absent, or there is nothing to read.
const notRepo = path.join(tmp, 'not-a-repo');
fs.mkdirSync(notRepo);
fs.writeFileSync(path.join(notRepo, 'f.txt'), OURS + '\n');
const refused = run(['--root', notRepo], ENV);
check('a directory git refuses is exit 2, never a pass', refused.status === 2 && /NO VERDICT: git ls-files failed/.test(refused.stderr), detail(refused));
const emptyPath = path.join(tmp, 'empty-path');
fs.mkdirSync(emptyPath);
const noGit = run(['--root', planted], { ...ENV, PATH: emptyPath, Path: emptyPath });
check('git missing from PATH is exit 2', noGit.status === 2 && /NO VERDICT: git could not run/.test(noGit.stderr), detail(noGit));
const empty = run(['--root', repo('empty', {})], ENV);
check('a repository tracking 0 files is exit 2', empty.status === 2 && /listed 0 files/.test(empty.stderr), detail(empty));

// --help answers and does no work (check:entrypoints probes it with a 10 s budget).
const help = run(['--help']);
check('--help prints usage and exits 0', help.status === 0 && /usage:/.test(help.stdout) && !/tracked file\(s\)/.test(help.stdout), detail(help));
const noArg = run(['--root']);
check('--root without a directory is exit 2', noArg.status === 2, detail(noArg));

// The real tree: every tracked file, this suite included, carries no marker.
const real = run([]);
const n = Number((String(real.stdout).match(/(\d+) tracked file\(s\)/) || [])[1] || 0);
check('this repo: no tracked file carries a marker', real.status === 0, detail(real));
check('  over a non-empty population', n > 0, `population=${n}`);

let pass = 0;
let fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`subject: tooling/check-conflict-markers.js, driven as a subprocess over ${repos} throwaway git repositories, one plain directory and this repo (${n} tracked files)`);
process.exitCode = fail ? 1 : 0;
