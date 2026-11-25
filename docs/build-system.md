# TypeScript Monorepo Build System

## Overview

**Critical: Use `tsc --build` for all TypeScript compilation.** This is the standard TypeScript solution for monorepos with dependencies between packages.

## Why `tsc --build`?

TypeScript's `--build` mode (project references) provides:
- **Dependency Order**: Automatically builds packages in the correct order based on `references` in tsconfig.json
- **Incremental Builds**: Only rebuilds packages that changed (uses `.tsbuildinfo` files)
- **Type Safety**: TypeScript validates cross-package imports at build time
- **Standard Solution**: This is TypeScript's official monorepo build approach

Without `--build`, builds fail on clean checkouts because dependent packages try to import from unbuilt packages.

## Required Configuration

Every package **must** have `composite: true` in its tsconfig.json:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "references": [
    { "path": "../utils" }
  ]
}
```

The `references` array tells TypeScript which packages this package depends on.

## Build Scripts

```bash
# Standard build (respects dependency order)
bun run build

# Clean build (removes all build artifacts and rebuilds)
bun run build:clean

# Type check without emitting files (fast)
bun run typecheck
```

These scripts map to:
- `build`: `turbo run build && turbo run build:skills`
- `build:clean`: `bun run clean && turbo run build --force && turbo run build:skills --force` — routed through
  turbo (and so through `tsc-clean-build.ts`’s staging emit) on purpose. A clean build that calls `tsc`
  directly bypasses the staging `outDir` and can report success on a tree the real build fails to compile.
- `clean`: removes build outputs only — `dist`, `*.tsbuildinfo`, `.tsc-staging`, `.test-output`. It does not
  touch `packages/*/schemas`, which hold tracked files.
- `clean:deps`: `rimraf --glob node_modules 'packages/*/node_modules'` — removes the root **and every
  package's** `node_modules` (dependency reset, not a build clean). Requires a `bun install` after.
- `typecheck`: `turbo run build && turbo run typecheck && bun run typecheck:root`. Each package's
  own `typecheck` is `tsc --noEmit -p tsconfig.eslint.json`: the same generated program its lint
  checks, source and tests together, under the same compiler settings. A package's `src/` alone is
  also compiled by its `build`. Like the lint, the task is keyed on what its program reads, not on
  `^build`: a program reaches packages its manifest does not depend on (`vitest.shared.ts` imports
  a dev-tools file that imports `schema`), which `^build` would neither build first nor hash. So the
  script builds every package first, and the task hashes every package's emitted declarations and
  manifest, the lockfile and the installed TypeScript: exactly the lint inputs that describe the
  program (see [Lint](#lint)), plus the out-of-package files the generated
  `packages/<pkg>/turbo.json` lists. `validate-structure` checks the script and both input lists,
  each both ways. `typecheck:root` is `tsc --noEmit -p tsconfig.root.json`, the root's own
  TypeScript (the three root vitest configs, `vitest.shared.ts`, `eslint-config-support.d.ts`): run
  every time, never cached, so it has no inputs to drift.

## How It Works

1. **Root tsconfig.json** lists all packages in `references`:
   ```json
   {
     "files": [],
     "references": [
       { "path": "./packages/utils" },
       { "path": "./packages/resources" },
       { "path": "./packages/rag" },
       // ... etc
     ]
   }
   ```

2. **Each package tsconfig.json** declares its dependencies:
   ```json
   {
     "references": [
       { "path": "../utils" },
       { "path": "../resources" }
     ]
   }
   ```

3. The dependency graph is walked and packages are built in order:
   - Builds `utils` (no dependencies)
   - Builds `resources` (depends on `utils`)
   - Builds `rag` (depends on `utils` and `resources`)
   - etc.

   ⚠️ **Two different mechanisms do that ordering, and `bun run build` is not the `tsc --build` one.**
   `bun run build` is `turbo run build && turbo run build:skills`; turbo orders the packages via
   `dependsOn: ["^build"]` in `turbo.json`, and each package's own `build` script is
   `tsx ../dev-tools/src/tsc-clean-build.ts` — a plain `tsc` invocation with the emit redirected to a
   `.tsc-staging` directory that is swapped into `dist/` at the end, so `dist/` stays continuously
   readable to a concurrent consumer. `tsc --build` proper survives only in `build:packages`
   (`tsc --build && cd packages/schema && bun run generate:schemas`), and the root `references` array
   below is what makes that script resolve correctly.

## Configuring New Package Builds

When creating a new package:
1. Add `"composite": true` to its tsconfig.json
2. Add `references` for packages it depends on
3. Add the package to root tsconfig.json `references` array
4. Run `bun install` to update workspace links
5. Run `bun run generate:lint-config`: it writes the package's `tsconfig.eslint.json` and, when the
   package reaches into another by a relative import, its `turbo.json` lint and typecheck inputs.
   Give it the `lint` script `VAT_LINT_TASK=1 eslint . --max-warnings=0` if ESLint lints any of its
   files, and none if it lints none; give it `typecheck`: `tsc --noEmit -p tsconfig.eslint.json` if
   it has a `tsconfig.eslint.json`, and none if it has none. `validate-structure` fails on a stale
   generated file or a wrong script.

## Lint

`bun run lint` is `turbo run build` followed by `turbo run lint lint:root`: one ESLint process per
package, each with its own type-checked program from that package's `tsconfig.eslint.json`, plus
`lint:root` for the root's own scripts. Types of another workspace package come
from its `dist/` (as for `tsc`), and so do a package's own types for a test that imports it by name.
`--concurrency=2` bounds one lint run to two programs at a time.

Turbo is the only lint cache. A package's lint hash covers:

- its own files (`$TURBO_DEFAULT$`);
- every package's emitted declarations (`dist/**/*.d.ts`, `*.d.cts`) and every `package.json`;
- the files outside the package that its program contains (a shared test helper or script
  generator reached by a relative import, and whatever those reach), as TypeScript itself builds the
  program from `tsconfig.eslint.json`, listed in the generated `packages/<pkg>/turbo.json`;
- `bun.lock`: a program that reaches another package's source reads that package's external types,
  which the package's own external-dependency hash does not cover;
- `eslint.config.js` and `tsconfig.*.json` (from `globalDependencies`), and, as lint inputs, what
  the config reads for every package: `eslint-config-support.js`, the ignore files, the rule sources
  under `packages/utils/eslint/`, and the installed manifest of every linter package it imports plus
  `eslint` and `typescript`.

Keying on declarations rather than on `dependsOn: ["^build"]` keeps an edit cheap: a build's hash
changes with every source edit, while a body, comment or private-helper edit leaves every
declaration byte-identical and re-lints only its own package. An edit that changes a declaration
re-lints every package, because the glob is not narrowed to each package's dependencies.

Nothing inside turbo orders `lint` after `build`, so the order is enforced by signals. A package's
`lint` script sets `VAT_LINT_TASK=1`; `eslint.config.js` then refuses to load unless the root script
set `VAT_LINT_BUILT=1` after its build (a pass-through env, not hashed) and every declared `types`
file of every package exists. Without that refusal an unresolved import types as `any` and turbo
caches the pass. Run lint only through `bun run lint` or `bun run lint:fix`. `lint:fix` bypasses
the cache (`--cache=local:,remote:`): a cached verdict would skip the fix. It keeps
`--max-warnings=0`, so it exits non-zero on what `--fix` could not fix.

`lint:root`'s code-file inputs are one glob per place holding a file it lints, each with a literal
prefix (today only `*.{js,...}` at the root): a glob without one makes turbo walk `node_modules`,
`.git` and other sessions' worktrees on every run.

`validate-structure` checks the lint wiring against `generate-lint-config.ts`: the generated
files, every `lint` script, that ESLint ignores what the repository's ignore files ignore (so no
lintable file sits outside the hashed inputs), that `IGNORE_FILES` is exactly the tracked
`.gitignore` files and both lint tasks hash them, that both tasks hash every file
`eslint.config.js` imports by relative path, that the linter-manifest inputs name exactly what it
imports, and that `lint:root`'s places match what it lints. Each check runs both ways. ESLint's own `--cache` is never used (see
[traps](contributing/traps.md#eslints---cache-replays-a-clean-verdict-a-type-aware-rule-would-now-red)).

## Troubleshooting

**"Cannot find module '@vibe-agent-toolkit/utils'" during build**:
- Missing `references` in tsconfig.json
- Package not built yet (run `bun run build:clean`)

**"Project references may not form a circular dependency"**:
- Check for circular imports between packages
- Packages must form a directed acyclic graph (DAG)

**Build succeeds but types are wrong**:
- Clear build outputs: `bun run clean`. Prefer it over `tsc --build --clean`, which leaves
  `.tsc-staging`/`.test-output` behind and — per `packages/dev-tools/src/tsc-clean-build.ts`'s own
  docstring — cannot remove the emitted output of a source file that has since been deleted, which is
  the usual cause of this symptom.
- Rebuild: `bun run build:clean` (which runs `bun run clean` first, then forces both turbo passes).

## Workspace Protocol for Internal Dependencies

**Critical: Use `workspace:*` for all internal package dependencies.**

Internal dependencies in package.json must use the workspace protocol, **not specific version numbers**:

```json
{
  "dependencies": {
    "@vibe-agent-toolkit/utils": "workspace:*",
    "@vibe-agent-toolkit/resources": "workspace:*"
  }
}
```

### Why `workspace:*`?

1. **CI Compatibility**: `bun install` in CI uses local workspace packages, not npm
2. **Auto-Resolution**: Publishing workflow runs `resolve-workspace-deps` to replace `workspace:*` with actual versions before `npm publish`
3. **Single Source of Truth**: Version is managed by `bump-version` script, not individual package.json files

**Without `workspace:*`**, CI builds fail because `bun install` tries to fetch packages from npm that don't exist yet:

```bash
# ❌ WRONG - CI tries to fetch from npm
"@vibe-agent-toolkit/utils": "0.1.0-rc.2"

# ✅ CORRECT - CI uses local workspace
"@vibe-agent-toolkit/utils": "workspace:*"
```

### Publishing Workflow

1. Developer commits code with `workspace:*` in package.json
2. Developer runs `bump-version` to create git tag (workspace:* unchanged)
3. GitHub Actions workflow triggers on tag:
   - `bun install` uses local workspace packages
   - `build` compiles all packages
   - `resolve-workspace-deps` replaces `workspace:*` with actual version
   - `npm publish` publishes with resolved dependencies
4. Published packages on npm have actual version numbers (e.g., "0.1.0-rc.7")
5. Workspace files in git remain unchanged with `workspace:*`

**Why not use `bun publish`?** Bun automatically replaces `workspace:*`, but doesn't support `--provenance` flag needed for supply chain security. We use `npm publish` with manual resolution instead.

### Fixing Incorrect Dependencies

If dependencies get out of sync (e.g., after manual edits), run:

```bash
bun run fix-workspace-deps
bun install
```

This ensures all internal dependencies use `workspace:*` protocol.

**For AI assistants**: When adding new internal dependencies, ALWAYS use `workspace:*`. Never use specific version numbers for @vibe-agent-toolkit packages.

## Why Not Custom Scripts?

We previously used a custom `run-in-packages.ts` script to run builds. This had problems:
- ❌ Didn't respect dependency order → failed on clean builds
- ❌ Required custom code to maintain
- ❌ Slower (no incremental builds)
- ❌ Not standard TypeScript

Using `tsc --build`:
- ✅ Respects dependency order automatically
- ✅ Zero custom code to maintain
- ✅ Faster with incremental builds
- ✅ Standard TypeScript solution

**Rule**: Never manually run `tsc` in an individual package's directory. Always build from the root —
`bun run build` (turbo → `tsc-clean-build.ts` per package) or `bun run build:packages`
(`tsc --build` over the root `references` graph). A hand-run `tsc` inside a package bypasses the
staging `outDir` and can report success on a tree the real build fails to compile.
