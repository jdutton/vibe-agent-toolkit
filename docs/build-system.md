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
- `build`: `tsc --build && cd packages/agent-schema && bun run generate:schemas`
- `build:clean`: `tsc --build --clean && tsc --build && cd packages/agent-schema && bun run generate:schemas`
- `typecheck`: `tsc --build --dry --force`

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

3. **`tsc --build`** walks the dependency graph and builds packages in order:
   - Builds `utils` (no dependencies)
   - Builds `resources` (depends on `utils`)
   - Builds `rag` (depends on `utils` and `resources`)
   - etc.

## Configuring New Package Builds

When creating a new package:
1. Add `"composite": true` to its tsconfig.json
2. Add `references` for packages it depends on
3. Add the package to root tsconfig.json `references` array
4. Run `bun install` to update workspace links

## Troubleshooting

**"Cannot find module '@vibe-agent-toolkit/utils'" during build**:
- Missing `references` in tsconfig.json
- Package not built yet (run `bun run build:clean`)

**"Project references may not form a circular dependency"**:
- Check for circular imports between packages
- Packages must form a directed acyclic graph (DAG)

**Build succeeds but types are wrong**:
- Delete `.tsbuildinfo` files: `tsc --build --clean`
- Rebuild: `bun run build:clean`

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

**Rule**: Never manually run `tsc` in individual packages. Always use `tsc --build` from the root.
