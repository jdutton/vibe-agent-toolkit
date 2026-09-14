---
paths:
  - "vitest.config.ts"
  - ".github/workflows/coverage.yml"
---

# The coverage thresholds ratchet from ONE measurement — never lower one by hand

`coverage.thresholds` in `vitest.config.ts` are measured over ALL of `src` (the exclusions above
them are justified file by file). They are seeded from exactly one run: the `coverage.yml` job,
which is Linux on the exact Node floor derived from `engines.node` — the only job whose VERDICT
on the unit suite is taken on the floor (the validate matrix is Node 24; `node-floor.yml`
smoke-tests; `test-heap-guard.yml` executes the cli/resource-compiler integration and system
tiers on the floor but reads only their heap lines, never pass/fail). A run on
another platform or Node counts different branches (a macOS run once wrote 77 % for branches; the
floor measured 76.99 % and CI could not meet it), so `autoUpdate` is armed only where
`COVERAGE_RATCHET=write`, which that job sets and nothing else does. A local `bun run
test:coverage` never rewrites the numbers.

The ratchet is asserted both ways there: below a threshold the run fails; a whole point above one,
autoUpdate rewrites the file and the next step fails on the diff, printing the raise to commit. A
drop is a coverage regression to fix or an exclusion to justify in place, never a number to edit.
(enforced by: `coverage.yml`, both directions; "never lower by hand" is not)

`bun run test:coverage` runs vitest directly, so its tail (the threshold verdict) is visible — the
vibe-validate wrapper drops it. Codecov is the coverage authority; SonarCloud's "Coverage on New
Code" is always zero
([why](../../docs/contributing/traps.md#sonarcloud-coverage-on-new-code-is-always-zero)).
