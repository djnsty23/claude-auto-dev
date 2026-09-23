#!/usr/bin/env node
// Suite for tooling/check-hook-parse.js, driven as a subprocess against fixture
// trees. The planted defect is a syntax error in a hook file, the one thing the
// check exists to catch; a clean tree and an empty tree are the controls.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CHECK = path.join(__dirname, 'check-hook-parse.js');
const cases = [];
const check = (label, ok, detail) => cases.push([label, ok, detail]);
const run = (args) => spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
const detail = (r) => `status=${r.status} signal=${r.signal} stdout=${JSON.stringify(String(r.stdout).slice(0, 300))} stderr=${JSON.stringify(String(r.stderr).slice(0, 300))}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hookparse-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* left in tmp */ } });

const tree = (name, hooks) => {
    const root = path.join(tmp, name);
    for (const [plugin, files] of Object.entries(hooks)) {
        const dir = path.join(root, 'plugins', plugin, 'hooks');
        fs.mkdirSync(dir, { recursive: true });
        for (const [f, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), src);
    }
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    return root;
};

const GOOD = "'use strict';\ntry { process.exit(0); } catch { process.exit(0); }\n";
// A missing closing brace: parses as nothing, and `node --check` names the file.
const BAD = "'use strict';\nfunction main() {\n    return 1;\n";

// Control: a clean two-plugin tree parses, and the population is printed.
const clean = run(['--root', tree('clean', { a: { 'one.js': GOOD, 'two.js': GOOD }, b: { 'three.js': GOOD } })]);
check('a clean tree exits 0', clean.status === 0 && clean.signal === null, detail(clean));
check('  and prints the population it parsed (3 files)', /3 hook file\(s\)/.test(clean.stdout) && /3 parse, 0 do not/.test(clean.stdout), detail(clean));

// The planted defect: one broken hook among good ones.
const red = run(['--root', tree('red', { a: { 'one.js': GOOD, 'broken.js': BAD }, b: { 'three.js': GOOD } })]);
check('a hook with a syntax error exits 1', red.status === 1 && red.signal === null, detail(red));
check('  and names the file', /\[FAIL\] plugins\/a\/hooks\/broken\.js/.test(red.stdout), detail(red));
check('  and carries node\'s reason, not only the name', /SyntaxError/.test(red.stdout), detail(red));
check('  and still counts the others as parsed', /3 hook file\(s\)/.test(red.stdout) && /2 parse, 1 do not/.test(red.stdout), detail(red));

// Only .js under hooks/ is the population: a broken .json or a .js elsewhere is not a hook.
const scope = tree('scope', { a: { 'one.js': GOOD, 'hooks.json': '{ not json' } });
fs.mkdirSync(path.join(scope, 'plugins', 'a', 'scripts'), { recursive: true });
fs.writeFileSync(path.join(scope, 'plugins', 'a', 'scripts', 'broken.js'), BAD);
const scoped = run(['--root', scope]);
check('files outside plugins/*/hooks/*.js are not graded', scoped.status === 0 && /1 hook file\(s\)/.test(scoped.stdout), detail(scoped));

// An empty tree is NO VERDICT, never a pass.
const empty = run(['--root', tree('empty', {})]);
check('zero hook files is exit 2, not a pass', empty.status === 2 && /NO VERDICT/.test(empty.stderr), detail(empty));

// --help answers and does no work (check:entrypoints probes this with a 10 s budget).
const help = run(['--help']);
check('--help prints usage and exits 0', help.status === 0 && /usage:/.test(help.stdout) && !/hook file\(s\)/.test(help.stdout), detail(help));
const noArg = run(['--root']);
check('--root without a directory is exit 2', noArg.status === 2, detail(noArg));

// The real tree: the population is not empty and every shipped hook parses.
const real = run([]);
const n = Number((String(real.stdout).match(/(\d+) hook file\(s\)/) || [])[1] || 0);
check('this repo: every shipped hook parses', real.status === 0, detail(real));
check('  over a non-empty population', n > 0, `population=${n}`);

let pass = 0;
let fail = 0;
for (const [label, ok, why] of cases) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok || !why ? '' : '  -> ' + why));
    ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
console.log(`subject: tooling/check-hook-parse.js, driven as a subprocess over 5 fixture trees and this repo (${n} hook files)`);
process.exitCode = fail ? 1 : 0;
