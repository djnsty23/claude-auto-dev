# Tooling Config Templates

TypeScript / Biome / shadcn / git metadata — boilerplate used by both single-app and monorepo scaffolds. Load this during Step 3 of Create mode.

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

**Version:** prefer TS 5.8. TS 6 (March 2026) is too fresh — ecosystem libraries still lagging.

## Biome — replaces ESLint + Prettier

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

Exclude `**/*.css` — Biome cannot parse Tailwind v4 `@theme` syntax.

## shadcn/ui v4

After `pnpm install`:

```bash
pnpm dlx shadcn@latest init --defaults --force
pnpm dlx shadcn@latest add button input card badge --yes
```

In monorepos, run from the web package directory. shadcn v4 defaults: `base-nova` style, Base UI primitives, `oklch()` colors, Tailwind v4 CSS variables. No `tailwind.config.ts` needed.

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
.claude/
*.tsbuildinfo
```

## .npmrc

```ini
strict-peer-dependencies=false
auto-install-peers=true
```
