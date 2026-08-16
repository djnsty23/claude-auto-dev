# Monorepo Scaffolding Templates

Load this when the user chose monorepo structure in Create mode. For single-app, use `pnpm create next-app .` and skip this file.

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

```json
{
  "private": true,
  "packageManager": "pnpm@10.8.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r run build",
    "dev": "pnpm -r --parallel run dev",
    "typecheck": "pnpm -r run typecheck",
    "lint": "biome check .",
    "format": "biome check --write .",
    "preinstall": "npx only-allow pnpm"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.0",
    "typescript": "^5.8.0"
  }
}
```

## Web package

Use `pnpm create next-app packages/web --typescript --tailwind --app --src-dir --use-pnpm --skip-install` then clean up: delete the nested `.git`, `.gitignore` (root owns it), README, and ESLint config.

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
