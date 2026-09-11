# Monorepo Scaffolding Templates

Load this when monorepo structure serves the requested new project. These are
structural examples; use the selected package manager and versions verified via
`version-defaults.md` and current official sources, then record exact resolved
versions. Validate every config with the installed tool before calling setup done.

## Layout

```
project/
├── pnpm-workspace.yaml
├── package.json            # root: orchestration only
├── tsconfig.base.json      # shared compiler options
├── tsconfig.json           # solution-style references
├── biome.json
├── .npmrc
├── .gitattributes
├── .gitignore
├── packages/
│   ├── engine/             # shared types + logic
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   └── web/                # Next.js app
│       ├── package.json
│       ├── tsconfig.json
│       └── src/app/
└── [optional: cli/, trigger/, supabase/]
```

## pnpm-workspace.yaml

```yaml
packages:
  - 'packages/*'
onlyBuiltDependencies:
  - sharp
  - unrs-resolver
  - esbuild
```

## Root package.json (orchestration only)

Replace the version placeholders before installing. The script list is a starting
point: verify every package is included in the checks it requires; a recursive
command must not silently skip a package with a missing script.

```json
{
  "private": true,
  "packageManager": "pnpm@<verified-version>",
  "engines": { "node": "<verified-compatible-range>" },
  "scripts": {
    "build": "pnpm -r run build",
    "dev": "pnpm -r --parallel run dev",
    "typecheck": "pnpm -r run typecheck",
    "lint": "biome check .",
    "format": "biome check --write .",
    "preinstall": "npx only-allow pnpm"
  },
  "devDependencies": {
    "@biomejs/biome": "<verified-version>",
    "typescript": "<verified-version>"
  }
}
```

## Web package

Use the selected scaffold CLI with verified flags in the new web directory.
Inspect generated metadata before cleanup: transfer relevant ignore/documentation
content to the root, retain the selected lint policy, and remove nested git metadata
only when this scaffold created it and no work or history needs preserving. Never
delete an existing repository or its conventions as routine scaffold cleanup.

## Shared package (e.g., `packages/engine`)

```json
{
  "name": "@<project>/engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

Consumer references: `"@<project>/engine": "workspace:*"`.
