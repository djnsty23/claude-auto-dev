#!/usr/bin/env node
// smart-explore.js — pure-JS, zero-dependency structural code outliner (offline).
//
// Roadmap §3.3 sketches a Tree-sitter AST explorer for token savings ("compact
// structural outlines instead of full file contents"). This delivers the SAME
// BENEFIT with a PURE-JS HEURISTIC extractor: no npm deps, no native build, no
// network — works everywhere. It is HONEST heuristic/regex extraction, NOT a real
// AST. It reads code line-by-line and pattern-matches definitions, so it can miss
// multi-line signatures, dynamically-computed exports, and unusual syntax. A true
// Tree-sitter AST remains an optional future upgrade for higher fidelity.
//
// Exports: { extractSymbols, summarizeFile, summarizeDir }
// CLI: node scripts/smart-explore.js <path> [--json]

const fs = require('fs');
const path = require('path');

// --- Config ---------------------------------------------------------------

const MAX_FILE_BYTES = 1024 * 1024; // 1MB read cap; larger files marked 'huge'
const MAX_DIR_FILES = 500; // bound total files walked in a directory
const NUL_SCAN_BYTES = 8192; // how far to scan for NUL bytes when sniffing binary

// Directories never walked.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
]);

// Source extensions recognized by summarizeDir. JS/TS/Py get structured
// extraction; the rest fall through to the generic keyword scan.
const RECOGNIZED_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py',
  '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cc', '.hpp',
  '.rb', '.php', '.cs', '.swift', '.kt', '.scala', '.sh',
]);

const JS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const TS_EXTS = new Set(['.ts', '.tsx']);

function languageOf(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (JS_EXTS.has(ext)) return 'javascript';
  if (TS_EXTS.has(ext)) return 'typescript';
  if (ext === '.py') return 'python';
  return ext ? ext.slice(1) : 'unknown';
}

// --- Symbol extraction ----------------------------------------------------

// extractSymbols(filePath, source) — dispatch by extension. Never throws: every
// extractor is wrapped so malformed input returns whatever was gathered.
function extractSymbols(filePath, source) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const src = source == null ? '' : String(source);
  try {
    if (JS_EXTS.has(ext) || TS_EXTS.has(ext)) return extractJs(src);
    if (ext === '.py') return extractPython(src);
    return extractGeneric(src);
  } catch (err) {
    // Heuristic parsers must never crash the caller.
    return { kind: 'error', error: String((err && err.message) || err) };
  }
}

// --- JavaScript / TypeScript ---------------------------------------------

function extractJs(src) {
  const lines = src.split(/\r?\n/);
  const imports = [];
  const functions = [];
  const arrows = [];
  const classes = [];
  const types = [];
  const constants = [];
  const exportsSet = new Set();

  // Regexes (line-anchored where sensible). Heuristic — single-line only.
  const reImportFrom = /^\s*import\s+[^;]*?\s+from\s+['"]([^'"]+)['"]/;
  const reImportBare = /^\s*import\s+['"]([^'"]+)['"]/;
  const reRequire = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/;
  const reFunc = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*\(([^)]*)\)/;
  const reArrow = /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?(\([^)]*\)|[A-Za-z0-9_$]+)\s*(?::\s*[^=>{]+)?=>/;
  const reClass = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$.]+))?/;
  const reInterface = /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/;
  const reType = /^\s*(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/;
  const reConst = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=/;
  const reExportList = /^\s*export\s*(?:type\s+)?\{([^}]*)\}/;
  const reExportDefault = /^\s*export\s+default\s+([A-Za-z0-9_$]+)/;
  const reModuleExportsObj = /^\s*module\.exports\s*=\s*\{([^}]*)\}/;
  const reModuleExportsName = /^\s*module\.exports\s*=\s*([A-Za-z0-9_$]+)/;
  const reModuleExportsProp = /^\s*(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/;
  // Method inside a class body: an identifier followed by (params) and a brace.
  const reMethod = /^\s*(?:public\s+|private\s+|protected\s+|readonly\s+)*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*[^={]+)?\{/;
  const NON_METHOD = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else',
  ]);

  // Brace-tracking so methods are only collected directly inside a class body.
  let depth = 0;
  const classStack = []; // { entry, bodyDepth }
  let pendingClass = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Imports / requires (can appear anywhere; capture the module specifier).
    let m;
    if ((m = line.match(reImportFrom))) imports.push({ from: m[1], line: lineNo });
    else if ((m = line.match(reImportBare))) imports.push({ from: m[1], line: lineNo });
    else {
      const rq = line.match(reRequire);
      if (rq) imports.push({ from: rq[1], line: lineNo });
    }

    // Top-level constructs are only recognized at brace depth 0.
    if (depth === 0) {
      if ((m = line.match(reFunc))) {
        functions.push({ name: m[1], params: splitParams(m[2]), line: lineNo });
        if (/^\s*export\b/.test(line)) exportsSet.add(m[1]);
      } else if ((m = line.match(reArrow))) {
        arrows.push({ name: m[1], params: arrowParams(m[2]), line: lineNo });
        if (/^\s*export\b/.test(line)) exportsSet.add(m[1]);
      } else if ((m = line.match(reType))) {
        types.push({ name: m[1], kind: 'type', line: lineNo });
        if (/^\s*export\b/.test(line)) exportsSet.add(m[1]);
      } else if ((m = line.match(reInterface))) {
        types.push({ name: m[1], kind: 'interface', line: lineNo });
        if (/^\s*export\b/.test(line)) exportsSet.add(m[1]);
      } else if ((m = line.match(reConst)) && !reArrow.test(line)) {
        constants.push({ name: m[1], line: lineNo });
        if (/^\s*export\b/.test(line)) exportsSet.add(m[1]);
      }
    }

    // Class declaration (record; body captured via brace tracking below).
    const cls = line.match(reClass);
    if (cls) {
      const entry = { name: cls[1], extends: cls[2] || null, methods: [], line: lineNo };
      classes.push(entry);
      pendingClass = entry;
      if (/^\s*export\b/.test(line)) exportsSet.add(cls[1]);
    }

    // Method detection: only when directly inside a class body.
    if (classStack.length && depth === classStack[classStack.length - 1].bodyDepth) {
      const mm = line.match(reMethod);
      if (mm && !NON_METHOD.has(mm[1])) {
        classStack[classStack.length - 1].entry.methods.push({
          name: mm[1], params: splitParams(mm[2]), line: lineNo,
        });
      }
    }

    // Export statements.
    if ((m = line.match(reExportList))) {
      for (const name of splitExportNames(m[1])) exportsSet.add(name);
    }
    if ((m = line.match(reExportDefault))) exportsSet.add(m[1]);
    if ((m = line.match(reModuleExportsObj))) {
      for (const name of splitExportNames(m[1])) exportsSet.add(name);
    } else if ((m = line.match(reModuleExportsName))) {
      exportsSet.add(m[1]);
    }
    if ((m = line.match(reModuleExportsProp))) exportsSet.add(m[1]);

    // Update brace depth char-by-char, coupling class body open/close.
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '{') {
        depth++;
        if (pendingClass) {
          classStack.push({ entry: pendingClass, bodyDepth: depth });
          pendingClass = null;
        }
      } else if (ch === '}') {
        if (classStack.length && classStack[classStack.length - 1].bodyDepth === depth) {
          classStack.pop();
        }
        if (depth > 0) depth--;
      }
    }
  }

  return {
    kind: 'js',
    imports,
    functions,
    arrows,
    classes,
    types,
    constants,
    exports: [...exportsSet],
  };
}

function splitParams(raw) {
  if (!raw || !raw.trim()) return [];
  // Split on top-level commas (heuristic: ignore commas inside <>, (), [], {}).
  const parts = [];
  let depthAngle = 0, depthParen = 0, depthBrack = 0, depthBrace = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '<') depthAngle++;
    else if (ch === '>') depthAngle = Math.max(0, depthAngle - 1);
    else if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBrack++;
    else if (ch === ']') depthBrack = Math.max(0, depthBrack - 1);
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    if (ch === ',' && !depthAngle && !depthParen && !depthBrack && !depthBrace) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  // Return just the parameter NAME (strip type annotations / defaults).
  return parts.map((p) => p.split(/[:=]/)[0].trim()).filter(Boolean);
}

function arrowParams(raw) {
  if (!raw) return [];
  if (raw.startsWith('(')) return splitParams(raw.slice(1, -1));
  return [raw.trim()]; // single unparenthesized param
}

function splitExportNames(raw) {
  return raw
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter((s) => s && /^[A-Za-z0-9_$]+$/.test(s));
}

// --- Python ---------------------------------------------------------------

function extractPython(src) {
  const lines = src.split(/\r?\n/);
  const imports = [];
  const functions = []; // top-level defs only
  const classes = [];
  let currentClass = null; // { entry, indent }

  const reImport = /^\s*import\s+(.+)/;
  const reFrom = /^\s*from\s+(\S+)\s+import\s+(.+)/;
  const reDef = /^(\s*)def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/;
  const reClass = /^(\s*)class\s+([A-Za-z0-9_]+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    let m;
    if ((m = line.match(reFrom))) {
      imports.push({ from: m[1], line: lineNo });
      continue;
    }
    if ((m = line.match(reImport)) && !/^\s*import\s*$/.test(line)) {
      imports.push({ from: m[1].split(/\s+as\s+/)[0].trim(), line: lineNo });
      continue;
    }

    if ((m = line.match(reClass))) {
      const indent = m[1].length;
      const entry = { name: m[2], methods: [], line: lineNo };
      classes.push(entry);
      // Only a top-level (indent 0) or shallower class becomes the enclosing one.
      if (currentClass && indent <= currentClass.indent) currentClass = null;
      currentClass = { entry, indent };
      continue;
    }

    if ((m = line.match(reDef))) {
      const indent = m[1].length;
      if (indent === 0) {
        // Top-level function; closes any open class scope.
        currentClass = null;
        functions.push({ name: m[2], params: pyParams(m[3]), line: lineNo });
      } else if (currentClass && indent > currentClass.indent) {
        // Indented def under a class → treat as a method. (Heuristic: a def
        // nested inside a method is also indented and would be attributed here;
        // this is a documented limitation of the indentation heuristic.)
        currentClass.entry.methods.push({ name: m[2], params: pyParams(m[3]), line: lineNo });
      }
      continue;
    }

    // A non-blank, non-comment line at indent 0 closes the class scope.
    if (currentClass && line.trim() && !/^\s/.test(line) && !line.trim().startsWith('#')) {
      currentClass = null;
    }
  }

  return { kind: 'python', imports, functions, classes };
}

function pyParams(raw) {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((p) => p.split(/[:=]/)[0].trim())
    .filter(Boolean);
}

// --- Generic fallback -----------------------------------------------------

function extractGeneric(src) {
  const lines = src.split(/\r?\n/);
  const defs = [];
  const reDef = /\b(function|def|class|func|fn|type|interface|struct|enum|module|trait|impl|export)\b/;
  const rePublic = /\b(public|protected|internal)\b[^;{]*\(/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
      continue;
    }
    if (reDef.test(line) || rePublic.test(line)) {
      const kw = (line.match(reDef) || [])[1] || 'public';
      defs.push({ keyword: kw, text: truncate(trimmed, 100), line: i + 1 });
      if (defs.length >= 400) break;
    }
  }

  if (defs.length === 0) {
    // Be honest: nothing structural found rather than fabricate symbols.
    return { kind: 'unstructured', lines: lines.length };
  }
  return { kind: 'generic', definitions: defs };
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// --- File / directory summaries ------------------------------------------

// summarizeFile(filePath) — read (guarding binary/huge files), extract symbols,
// and report source vs outline size.
function summarizeFile(filePath) {
  const language = languageOf(filePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return {
      file: filePath, language, symbols: { kind: 'error', error: String(err.message || err) },
      sourceChars: 0, outlineChars: 0,
    };
  }

  if (stat.size > MAX_FILE_BYTES) {
    const symbols = { kind: 'huge', bytes: stat.size };
    return {
      file: filePath, language, symbols,
      sourceChars: stat.size, outlineChars: renderFileOutline({ file: filePath, language, symbols }).length,
    };
  }

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return {
      file: filePath, language, symbols: { kind: 'error', error: String(err.message || err) },
      sourceChars: 0, outlineChars: 0,
    };
  }

  // Binary sniff: a NUL byte in the first chunk means "not source text".
  if (isBinaryBuffer(buf)) {
    const symbols = { kind: 'binary', bytes: buf.length };
    return {
      file: filePath, language, symbols,
      sourceChars: buf.length, outlineChars: renderFileOutline({ file: filePath, language, symbols }).length,
    };
  }

  const source = buf.toString('utf8');
  const symbols = extractSymbols(filePath, source);
  const summary = { file: filePath, language, symbols, sourceChars: source.length, outlineChars: 0 };
  summary.outlineChars = renderFileOutline(summary).length;
  return summary;
}

function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, NUL_SCAN_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// summarizeDir(dir, opts) — walk recursively, skipping vendored/build dirs and
// dotdirs, including only recognized source extensions. Bounded to MAX_DIR_FILES.
function summarizeDir(dir, opts = {}) {
  const maxFiles = opts.maxFiles || MAX_DIR_FILES;
  const files = [];
  let truncated = false;

  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sort for deterministic output; directories and files interleaved fine.
    entries.sort((a, b) => (a.name < b.name ? 1 : -1)); // reverse: stack pops in order
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        stack.push(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!RECOGNIZED_EXTS.has(ext)) continue;
        if (files.length >= maxFiles) { truncated = true; continue; }
        files.push(full);
      }
    }
  }

  files.sort();
  const summaries = files.map((f) => summarizeFile(f));

  let sourceChars = 0, outlineChars = 0;
  for (const s of summaries) { sourceChars += s.sourceChars; outlineChars += s.outlineChars; }
  const savedPct = sourceChars > 0 ? Math.round((1 - outlineChars / sourceChars) * 100) : 0;

  if (truncated) {
    process.stderr.write(`[smart-explore] file cap reached (${maxFiles}); output truncated\n`);
  }

  return {
    files: summaries,
    aggregate: { files: summaries.length, sourceChars, outlineChars, savedPct, truncated },
  };
}

// --- Rendering (compact, token-saving) -----------------------------------

function renderFileOutline(summary, opts = {}) {
  const s = summary.symbols || {};
  const rel = opts.relTo ? path.relative(opts.relTo, summary.file) : summary.file;
  const out = [];
  out.push(`${rel}:`);

  if (s.kind === 'binary') { out.push('  [binary — skipped]'); return out.join('\n'); }
  if (s.kind === 'huge') { out.push(`  [huge ${s.bytes} bytes — skipped]`); return out.join('\n'); }
  if (s.kind === 'error') { out.push(`  [unreadable: ${s.error}]`); return out.join('\n'); }
  if (s.kind === 'unstructured') { out.push(`  [no structure detected — ${s.lines} lines]`); return out.join('\n'); }

  if (s.kind === 'generic') {
    for (const d of s.definitions.slice(0, 40)) out.push(`  ${d.text} :${d.line}`);
    return out.join('\n');
  }

  // JS / Python structured output.
  if (s.imports && s.imports.length) {
    out.push('  import: ' + s.imports.map((i) => i.from).join(', '));
  }
  if (s.functions && s.functions.length) {
    for (const f of s.functions) out.push(`  fn ${f.name}(${f.params.join(', ')}) :${f.line}`);
  }
  if (s.arrows && s.arrows.length) {
    for (const a of s.arrows) out.push(`  fn ${a.name}(${a.params.join(', ')}) :${a.line}  [arrow]`);
  }
  if (s.types && s.types.length) {
    for (const t of s.types) out.push(`  ${t.kind} ${t.name} :${t.line}`);
  }
  if (s.classes && s.classes.length) {
    for (const c of s.classes) {
      const ext = c.extends ? ` extends ${c.extends}` : '';
      const methods = c.methods.map((mth) => mth.name).join(', ');
      out.push(`  class ${c.name}${ext} { ${methods} } :${c.line}`);
    }
  }
  if (s.constants && s.constants.length) {
    out.push('  const: ' + s.constants.map((c) => c.name).join(', '));
  }
  if (s.exports && s.exports.length) {
    out.push('  export: ' + s.exports.join(', '));
  }
  if (out.length === 1) out.push('  [no top-level symbols detected]');
  return out.join('\n');
}

// --- CLI ------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));

  if (!target) {
    process.stderr.write('Usage: node scripts/smart-explore.js <path> [--json]\n');
    process.exit(2);
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (err) {
    process.stderr.write(`smart-explore: cannot access ${target}: ${err.message}\n`);
    process.exit(1);
  }

  if (stat.isDirectory()) {
    const result = summarizeDir(target);
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }
    for (const f of result.files) {
      process.stdout.write(renderFileOutline(f, { relTo: target }) + '\n');
    }
    const a = result.aggregate;
    process.stdout.write(
      `\nOutline: ${a.outlineChars} chars vs ${a.sourceChars} source chars ` +
      `(~${a.savedPct}% smaller) across ${a.files} files\n`
    );
  } else {
    const summary = summarizeFile(target);
    if (json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      return;
    }
    process.stdout.write(renderFileOutline(summary) + '\n');
    const pct = summary.sourceChars > 0
      ? Math.round((1 - summary.outlineChars / summary.sourceChars) * 100)
      : 0;
    process.stdout.write(
      `\nOutline: ${summary.outlineChars} chars vs ${summary.sourceChars} source chars (~${pct}% smaller)\n`
    );
  }
}

module.exports = { extractSymbols, summarizeFile, summarizeDir, renderFileOutline };

if (require.main === module) {
  main(process.argv);
}
