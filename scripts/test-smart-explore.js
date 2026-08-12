#!/usr/bin/env node
// Tests for scripts/smart-explore.js — the pure-JS heuristic structural outliner.
// Zero dependencies. Asserts specific extracted symbol names/params so these fail
// loudly if extraction regresses (not just "non-empty").
// Run: node scripts/test-smart-explore.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractSymbols, summarizeFile, summarizeDir } = require('./smart-explore');

const cases = [];
const has = (arr, pred) => Array.isArray(arr) && arr.some(pred);

// --- JS extraction --------------------------------------------------------
{
  const src = [
    "import { readFile } from 'fs';",
    "const path = require('path');",
    '',
    'function foo(a, b) {',
    '  return a + b;',
    '}',
    '',
    'const bar = () => 42;',
    'export const baz = (x, y) => x * y;',
    '',
    'class Baz extends Base {',
    '  qux() { return 1; }',
    '  async quux(n) { return n; }',
    '}',
    '',
    'const settings = { a: 1 };',
    'export { foo };',
    'module.exports = { foo, Baz };',
  ].join('\n');

  const s = extractSymbols('sample.js', src);
  cases.push(['js: kind is js', s.kind === 'js']);
  cases.push(['js: import "fs" captured', has(s.imports, (i) => i.from === 'fs')]);
  cases.push(['js: require "path" captured', has(s.imports, (i) => i.from === 'path')]);
  cases.push(['js: function foo extracted with params [a,b]',
    has(s.functions, (f) => f.name === 'foo' && f.params.join(',') === 'a,b' && f.line === 4)]);
  cases.push(['js: arrow const bar extracted', has(s.arrows, (a) => a.name === 'bar')]);
  cases.push(['js: arrow const baz extracted with params [x,y]',
    has(s.arrows, (a) => a.name === 'baz' && a.params.join(',') === 'x,y')]);
  const baz = (s.classes || []).find((c) => c.name === 'Baz');
  cases.push(['js: class Baz extracted (extends Base)', !!baz && baz.extends === 'Base']);
  cases.push(['js: class Baz has method qux', !!baz && has(baz.methods, (m) => m.name === 'qux')]);
  cases.push(['js: class Baz has method quux', !!baz && has(baz.methods, (m) => m.name === 'quux')]);
  cases.push(['js: constant settings noted', has(s.constants, (c) => c.name === 'settings')]);
  cases.push(['js: export includes foo', (s.exports || []).includes('foo')]);
  cases.push(['js: export includes Baz (module.exports)', (s.exports || []).includes('Baz')]);
}

// --- TS extraction --------------------------------------------------------
{
  const src = [
    'export interface User { id: number; name: string; }',
    'export type Id = string | number;',
    '',
    'export function typed(a: number, b: string): boolean {',
    '  return true;',
    '}',
    '',
    'export class Service {',
    '  run(input: string): void {}',
    '}',
  ].join('\n');

  const s = extractSymbols('sample.ts', src);
  cases.push(['ts: interface User extracted',
    has(s.types, (t) => t.name === 'User' && t.kind === 'interface')]);
  cases.push(['ts: type Id extracted', has(s.types, (t) => t.name === 'Id' && t.kind === 'type')]);
  cases.push(['ts: typed function name+params extracted',
    has(s.functions, (f) => f.name === 'typed' && f.params.join(',') === 'a,b')]);
  const svc = (s.classes || []).find((c) => c.name === 'Service');
  cases.push(['ts: class Service extracted', !!svc]);
  cases.push(['ts: class Service has method run', !!svc && has(svc.methods, (m) => m.name === 'run')]);
}

// --- Python extraction ----------------------------------------------------
{
  const src = [
    'import os',
    'from collections import defaultdict',
    '',
    'def top_level(a, b):',
    '    def nested():',
    '        return 1',
    '    return nested()',
    '',
    'class Widget:',
    '    def method(self, x):',
    '        return x',
    '',
    'def another():',
    '    pass',
  ].join('\n');

  const s = extractSymbols('sample.py', src);
  cases.push(['py: kind is python', s.kind === 'python']);
  cases.push(['py: import os captured', has(s.imports, (i) => i.from === 'os')]);
  cases.push(['py: from collections captured', has(s.imports, (i) => i.from === 'collections')]);
  cases.push(['py: top-level def top_level extracted',
    has(s.functions, (f) => f.name === 'top_level' && f.params.join(',') === 'a,b')]);
  cases.push(['py: top-level def another extracted', has(s.functions, (f) => f.name === 'another')]);
  // Indentation-based: a nested def inside a function must NOT be top-level.
  cases.push(['py: nested def NOT mislabeled top-level',
    !has(s.functions, (f) => f.name === 'nested')]);
  const widget = (s.classes || []).find((c) => c.name === 'Widget');
  cases.push(['py: class Widget extracted', !!widget]);
  cases.push(['py: class Widget has method "method"',
    !!widget && has(widget.methods, (m) => m.name === 'method')]);
  // The class method is NOT counted as a top-level function.
  cases.push(['py: class method NOT counted as top-level fn',
    !has(s.functions, (f) => f.name === 'method')]);
}

// --- Token-saving ---------------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-'));
  const file = path.join(tmp, 'realistic.js');
  const body = [];
  body.push("const http = require('http');");
  for (let i = 0; i < 12; i++) {
    body.push(`function handler${i}(req, res) {`);
    body.push(`  // do something meaningful with ${i}`);
    body.push('  const data = fetchSomething(req.params.id);');
    body.push('  res.end(JSON.stringify(data));');
    body.push('}');
    body.push('');
  }
  body.push('module.exports = { handler0, handler1 };');
  fs.writeFileSync(file, body.join('\n'));

  const summary = summarizeFile(file);
  cases.push(['save: handler0 extracted', has(summary.symbols.functions, (f) => f.name === 'handler0')]);
  cases.push(['save: outlineChars < sourceChars', summary.outlineChars < summary.sourceChars]);
  cases.push(['save: meaningful margin (outline < 40% of source)',
    summary.outlineChars < summary.sourceChars * 0.4]);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Robustness -----------------------------------------------------------
{
  // Unknown extension with structural keywords → generic (no crash).
  const goSrc = 'package main\nfunc main() {\n  println("hi")\n}\n';
  const g = extractSymbols('main.go', goSrc);
  cases.push(['robust: unknown ext → generic', g.kind === 'generic' && g.definitions.length > 0]);

  // Unknown extension with nothing structural → unstructured (honest).
  const plain = extractSymbols('notes.xyz', 'hello there\njust prose here\nnothing to see');
  cases.push(['robust: no structure → unstructured', plain.kind === 'unstructured' && plain.lines === 3]);

  // Empty string → no crash, empty symbols.
  const empty = extractSymbols('empty.js', '');
  cases.push(['robust: empty string → no crash, empty functions',
    empty.kind === 'js' && empty.functions.length === 0]);

  // extractSymbols never throws on garbage input.
  let threw = false;
  try { extractSymbols('weird.ts', '((((((\nfunction {{{{ } )'); } catch { threw = true; }
  cases.push(['robust: malformed input does not throw', !threw]);

  // A file with a NUL byte → marked binary / skipped.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-bin-'));
  const binFile = path.join(tmp, 'blob.js');
  fs.writeFileSync(binFile, Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x62, 0x61, 0x72]));
  const binSummary = summarizeFile(binFile);
  cases.push(['robust: NUL-byte file marked binary', binSummary.symbols.kind === 'binary']);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Directory summary ----------------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explore-dir-'));
  fs.writeFileSync(path.join(tmp, 'a.js'), 'function a() {}\n');
  fs.writeFileSync(path.join(tmp, 'b.py'), 'def b():\n    pass\n');
  fs.mkdirSync(path.join(tmp, 'node_modules'));
  fs.writeFileSync(path.join(tmp, 'node_modules', 'skip.js'), 'function nope() {}\n');
  fs.writeFileSync(path.join(tmp, 'readme.md'), '# not source\n');

  const result = summarizeDir(tmp);
  cases.push(['dir: found exactly 2 source files (skipped node_modules + .md)',
    result.aggregate.files === 2]);
  cases.push(['dir: aggregate savedPct is a number', typeof result.aggregate.savedPct === 'number']);
  cases.push(['dir: no node_modules file included',
    !result.files.some((f) => f.file.includes('node_modules'))]);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Extraction fixes (regression guards for the adversarial-review bugs) --
{
  // Python: `async def` at top level AND as a method must be captured.
  const src = [
    'import asyncio',
    '',
    'async def afetch(url):',
    '    return url',
    '',
    'class AsyncClient:',
    '    async def aget(self, path):',
    '        return path',
    '    def sync_get(self, path):',
    '        return path',
  ].join('\n');
  const s = extractSymbols('async.py', src);
  cases.push(['py: top-level async def afetch extracted with params [url]',
    has(s.functions, (f) => f.name === 'afetch' && f.params.join(',') === 'url')]);
  const client = (s.classes || []).find((c) => c.name === 'AsyncClient');
  cases.push(['py: async def method aget captured inside class',
    !!client && has(client.methods, (m) => m.name === 'aget')]);
  cases.push(['py: async def afetch NOT double-counted as a method',
    !!client && !has(client.methods, (m) => m.name === 'afetch')]);
}

{
  // TS generic function: `<T>` between name and `(` must not drop the function.
  const src = [
    'export function generic<T>(x: T): T {',
    '  return x;',
    '}',
  ].join('\n');
  const s = extractSymbols('generic.ts', src);
  cases.push(['ts: generic function name "generic" extracted',
    has(s.functions, (f) => f.name === 'generic' && f.params.join(',') === 'x')]);
  cases.push(['ts: generic function NOT captured under a bogus name "function"/"T"',
    !has(s.functions, (f) => f.name === 'function' || f.name === 'T')]);
}

{
  // export default function/class must NOT emit a phantom "function"/"class" export.
  const src = [
    'export default function ff() {}',
  ].join('\n');
  const s = extractSymbols('defaultfn.ts', src);
  cases.push(['ts: export default function ff captured as real function',
    has(s.functions, (f) => f.name === 'ff')]);
  cases.push(['ts: export default function does NOT emit phantom "function" export',
    !(s.exports || []).includes('function')]);
  cases.push(['ts: real symbol ff is still exported', (s.exports || []).includes('ff')]);

  const src2 = ['export default class CC {}'].join('\n');
  const s2 = extractSymbols('defaultclass.ts', src2);
  cases.push(['ts: export default class CC captured as real class',
    has(s2.classes, (c) => c.name === 'CC')]);
  cases.push(['ts: export default class does NOT emit phantom "class" export',
    !(s2.exports || []).includes('class')]);
  cases.push(['ts: real symbol CC is still exported', (s2.exports || []).includes('CC')]);
}

{
  // FALSE-POSITIVE guard: a def-like keyword inside a comment or string must NOT
  // become a symbol.
  const src = [
    '// function fake(){}',
    'const s = "class NotReal {}";',
    'function real() { return 1; }',
  ].join('\n');
  const s = extractSymbols('fp.js', src);
  const names = [
    ...(s.functions || []).map((f) => f.name),
    ...(s.arrows || []).map((a) => a.name),
    ...(s.classes || []).map((c) => c.name),
    ...(s.constants || []).map((c) => c.name),
    ...(s.exports || []),
  ];
  cases.push(['fp: commented-out "fake" is not extracted', !names.includes('fake')]);
  cases.push(['fp: "NotReal" inside a string literal is not extracted', !names.includes('NotReal')]);
  cases.push(['fp: the real function is still extracted', has(s.functions, (f) => f.name === 'real')]);
}

{
  // `#private()` method captured; TS `enum` captured.
  const src = [
    'enum Color { Red, Green, Blue }',
    '',
    'class Store {',
    '  #priv() { return 1; }',
    '  pub() { return 2; }',
    '}',
  ].join('\n');
  const s = extractSymbols('enum.ts', src);
  cases.push(['ts: enum Color captured as a type',
    has(s.types, (t) => t.name === 'Color' && t.kind === 'enum')]);
  const store = (s.classes || []).find((c) => c.name === 'Store');
  cases.push(['ts: #priv() private method captured',
    !!store && has(store.methods, (m) => m.name === '#priv')]);
}

// --- Report ---------------------------------------------------------------
let pass = 0, fail = 0;
cases.forEach(([label, ok]) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  ok ? pass++ : fail++;
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
