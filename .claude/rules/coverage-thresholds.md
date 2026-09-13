---
paths:
  - "vitest.config.ts"
  - ".github/workflows/coverage.yml"
---

# The coverage thresholds are a self-raising ratchet — never lower one by hand

`coverage.thresholds` in `vitest.config.ts` are measured over ALL of `src` (the exclusions above
them are justified file by file) and `autoUpdate` rewrites them upward, in whole points, whenever a
run measures higher — commit that rewrite. A drop is a coverage regression to fix or an exclusion
to justify in place, never a number to edit. (enforced by: `coverage.yml`; the "never lower" half
is not)

Only the unit tier is coverage-instrumented; `bun run test:coverage` runs vitest directly, so its
tail (the threshold verdict) is visible — the vibe-validate wrapper drops it. Codecov is the
coverage authority; SonarCloud's "Coverage on New Code" is always zero
([why](../../docs/contributing/traps.md#sonarcloud-coverage-on-new-code-is-always-zero)).
