# Tooling Config Templates

Templates for the selected tooling in a new project. Load during Create Step 3.
Preserve existing policy during onboarding. Validate templates against the installed
versions; configuration syntax and defaults below are examples, not current API
guarantees. Keep version choices in `version-defaults.md` and verify them at use.

## TypeScript — maximum strictness

Start from Next.js defaults, add these flags to every tsconfig:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

**Monorepo:** `tsconfig.base.json` at root with shared options (`target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `composite: true`). Per-package configs extend it. Root `tsconfig.json` is solution-style: `"files": []` with `"references"` only.

**Version:** use the verified project version; see `version-defaults.md` for its
dated baseline. Do not override that choice from an older template note.

## Biome — when selected for this project

Generate/update the schema and supported keys with the installed CLI, validate
the result, and retain required checks when migrating an existing linter.

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.10/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "rules": {
      "recommended": true,
      "correctness": { "noUnusedImports": "error", "noUnusedVariables": "error" },
      "style": { "noNonNullAssertion": "error", "useImportType": "error" },
      "suspicious": { "noExplicitAny": "error" }
    }
  },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } },
  "files": {
    "includes": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.json"],
    "ignore": ["**/dist", "**/node_modules", "**/.next", "**/coverage", "**/*.css"]
  }
}
```

Check CSS parsing with the installed tool and the project's actual Tailwind
syntax. Exclude unsupported syntax only when reproduced, and preserve another
applicable CSS check; do not permanently waive CSS validation from this template.

## shadcn/ui when selected

Use the installed or verified pinned component CLI and its current documented
flags. Inspect existing component configuration first. Initialize only a new
configuration and install the components the requested flow needs; do not force
replacement of an existing design system. In a monorepo use the web package's
working directory. Read back the generated theme/configuration and run its checks.

## .gitattributes (cross-platform essential)

```
* text=auto
*.ts text eol=lf
*.tsx text eol=lf
*.js text eol=lf
*.mjs text eol=lf
*.json text eol=lf
*.css text eol=lf
*.md text eol=lf
*.yaml text eol=lf
*.yml text eol=lf
*.sql text eol=lf
*.sh text eol=lf
*.cmd text eol=crlf
*.bat text eol=crlf
*.ps1 text eol=crlf
*.png binary
*.jpg binary
*.ico binary
*.woff2 binary
pnpm-lock.yaml -diff
```

## .gitignore additions (beyond create-next-app)

```
.env
.env.*
!.env.example
supabase/.branches
supabase/.temp
.turbo/
*.tsbuildinfo
```

For tool-generated files, apply `rule-file-organization` to distinguish ephemeral
state from durable queues, acceptance evidence and tracked PRD archives. A blanket
`.claude/` rule can hide the only delivery evidence another session needs.

## .npmrc

Keep the project's existing peer-dependency policy. Do not globally suppress peer
compatibility failures as routine scaffolding. If installation reports a conflict,
reproduce it, choose compatible versions or document a narrowly justified existing
exception, and verify the resulting dependency graph with the actual project checks.
