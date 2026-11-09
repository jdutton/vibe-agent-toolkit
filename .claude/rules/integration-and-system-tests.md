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
prints "No test files found" and exits 1 having run nothing. The per-file duration ratchet is
judged only by the three root configs, which run one file at a time; a per-package run carries no
budget reporter, so it cannot tell you whether a file is over budget — for that, run the root
config ([`docs/writing-tests.md`](../../docs/writing-tests.md#the-per-file-duration-budget)).
(not enforced)

- Whole tiers: `bun run test:integration` / `bun run test:system` — never `bun test`, which
  ignores every vitest config and runs all tiers in one process.
- These tiers are `runScope: ci`: the pre-commit hook does not run them, `bun run validate` and CI
  do. A green commit is not a green PR.
- Goldens (`packaged-output-drift`, `pipeline-oracles`) compare BUILT output: `bun run build`
  first, then `UPDATE_DRIFT_GOLDEN=1` on the one file from its package directory, and read the
  diff — it must be exactly your edit.
- A test that reads a workspace package's built `dist/` needs turbo to order the task that
  PRODUCES that path before the test's tier task. The producer is the reached package's task whose
  `outputs` glob covers the path most specifically (`dist/skills/**` → `build:skills`, else
  `build`). Wire it with a `workspace:*` devDependency when the producer is a `build` and that
  makes no cycle; otherwise add the producer to a `<pkg>#test:<tier>` entry's `dependsOn` in
  `turbo.json`. That entry replaces the generic task's settings rather than merging with them, so
  copy its `dependsOn`, `outputs`, `cache` and `env`.
  (enforced by: `validate-structure`, `checkBuiltOutputEdges`, which reads turbo's own
  `--dry=json` graph)
  - **What counts as a reach.** The rule parses each test-tree source file (`test/**`,
    `src/**/*.test.*`, excluding `fixtures/` and `golden/`) and reads the strings that build a
    path. A string counts only as an argument to a `join`/`resolve` callee, `new URL`, `import()`,
    `require`, `vi.mock`/`vi.doMock`, `spawn*`/`exec*`/`fork`, or as a same-file `const` or
    template that flows into one. The path counts when it contains `<..|packages>/<workspace
    dir>/dist`, whatever precedes it. Comments and plain test data never count.
  - **Helpers.** A reach in a helper counts for every test file that imports it through relative
    imports, across packages too. It is attributed to the importing package's tier task.
  - **Package scripts.** A `package.json` script that reads a sibling's `dist/` is attributed to
    the turbo task that runs it.
  - **Findings.** Each of these fails the rule:
    - a reach whose producer is not ordered before the reader;
    - a reach no task's `outputs` cover;
    - a `dist/` path whose package segment is not a literal;
    - a test file in a tier the package has no script for;
    - a script no turbo task runs;
    - turbo itself failing or exceeding 60 s. The finding carries turbo's stderr.
- A test under this rule runs real processes: use `NODE_EXECUTABLE` / `gitExecutable()` from
  `@vibe-agent-toolkit/utils/testing` rather than spawning `node` or `git` by name.
  (enforced by: `local/no-bare-executable-spawn`, repo-wide, no allowlist)
