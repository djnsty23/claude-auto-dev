---
name: smart-explore
description: Emit a compact structural outline of code (signatures, classes, imports, exports) to save tokens vs reading whole files
when_to_use: "Invoked when the user says \"smart explore\", \"explore code\", \"outline\", \"map the codebase\", \"code outline\"."
allowed-tools: Bash, Read
model: opus
user-invocable: true
---

# Smart Explore

Emit a **compact structural outline** of a file or directory — imports, function
signatures, class names and their methods, and exports — instead of reading whole
files. On this repo it runs ~95% smaller than the raw source, so you can map an
unfamiliar codebase or recall a module's shape for a fraction of the tokens.

## Commands

| Say | Does |
|-----|------|
| `smart explore <path>` | Outline a file or directory (path is a file or folder) |
| `code outline <path>` | Same |
| `map the codebase` | Outline the current project directory |
| `outline <path>` | Same |

## How It Works

This is a **pure-JS, zero-dependency heuristic extractor** — no npm packages, no
native build, no network, works offline everywhere. It reads code line-by-line
and pattern-matches definitions:

- **JavaScript / TypeScript** (`.js .mjs .cjs .ts .tsx .jsx`): imports/requires,
  top-level `function` declarations (including generic `foo<T>(…)`, name + params
  + line), arrow-function consts, `class` names + their methods (including
  `#private()` methods), `interface` / `type` / `enum` names, `export` /
  `module.exports` names, and notable top-level consts. TS constructor-parameter
  modifiers (`public`/`private`/`protected`/`readonly`) are stripped so a param
  reads `http`, not `private http`.
- **Python** (`.py`): `import` / `from`, top-level `def` / `async def` and
  `class` (with methods, including `async def` methods), using indentation to
  detect top level.
- **Other languages**: a generic keyword scan (`function`, `def`, `class`,
  `func`, `type`, `public …(`, etc.). When nothing structural is found it
  honestly reports `[no structure detected — N lines]` rather than inventing
  symbols.

Directories are walked recursively, skipping `node_modules`, `.git`, `dist`,
`build`, `.next`, `coverage`, and dotdirs, and are bounded to ~500 files.

### Honest limitations (heuristic, NOT a real AST)

This is regex/line-based structural extraction, **not** a parsed AST. It can miss
or misread:

- **Multi-line signatures** — a `function foo(` whose params span several lines
  captures only what's on the first line.
- **Dynamic / computed exports** — `export * from …`, re-exports, and exports
  built at runtime.
- **Decorators & unusual syntax** — decorators, unconventional formatting,
  template-string braces, or minified code can confuse the brace tracker.
- **Nested `def` inside a method (Python)** — a `def` nested inside a method is
  indented like a sibling method and is attributed to the enclosing class.
- **IIFEs / assigned expressions** — a const assigned an immediately-invoked
  function may show up oddly.

Use it as a fast map, then `Read` the specific lines it points at when you need
exact detail. A true **Tree-sitter AST** (24+ languages, higher fidelity) remains
an optional future upgrade — this dependency-free version ships the same
token-saving benefit today.

## Implementation

Shells to the pure-Node CLI:

```bash
# Outline a single file
node "${CLAUDE_PLUGIN_ROOT}/scripts/smart-explore.js" "src/server.js"

# Outline a directory (per-file signatures + a final % savings line)
node "${CLAUDE_PLUGIN_ROOT}/scripts/smart-explore.js" "src"

# Machine-readable structured output
node "${CLAUDE_PLUGIN_ROOT}/scripts/smart-explore.js" "src" --json
```

The command prints a compact outline to stdout and a final
`Outline: X chars vs Y source chars (~Z% smaller)` line.

## When to Use

- Onboarding to an unfamiliar codebase — map its shape cheaply first
- Recalling a module's public surface (functions, classes, exports) without
  re-reading it
- Deciding which files are worth a full `Read` before a change
- Building a mental import/structure graph across a directory
