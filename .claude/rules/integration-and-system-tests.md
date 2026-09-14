---
paths:
  - "**/*.integration.test.ts"
  - "**/*.system.test.ts"
  - "vitest.integration.config.ts"
  - "vitest.system.config.ts"
  - "packages/*/vitest.integration.config.ts"
  - "packages/*/vitest.system.config.ts"
---

# Run one integration or system file from its package, with that tier's config

```
cd packages/<pkg> && bunx vitest run --config vitest.integration.config.ts test/integration/<file>
```

The default root config (`vitest.config.ts`) is the UNIT config: it excludes
`*.integration.test.ts` and `*.system.test.ts`, so `bunx vitest run <file>` from the repo root
prints "No test files found" and exits 1 having run nothing. The seeds in the duration allowlist
were measured under the per-package turbo runs, so a file's budget verdict is only comparable when
run the same way ([`docs/writing-tests.md`](../../docs/writing-tests.md#the-per-file-duration-budget)).
(not enforced)

- Whole tiers: `bun run test:integration` / `bun run test:system` — never `bun test`, which
  ignores every vitest config and runs all tiers in one process.
- These tiers are `runScope: ci`: the pre-commit hook does not run them, `bun run validate` and CI
  do. A green commit is not a green PR.
- Goldens (`packaged-output-drift`, `pipeline-oracles`) compare BUILT output: `bun run build`
  first, then `UPDATE_DRIFT_GOLDEN=1` on the one file from its package directory, and read the
  diff — it must be exactly your edit.
- A test under this rule runs real processes: use `NODE_EXECUTABLE` / `gitExecutable()` from
  `@vibe-agent-toolkit/utils/testing` rather than spawning `node` or `git` by name.
  (enforced by: `local/no-bare-executable-spawn`, repo-wide, no allowlist)
