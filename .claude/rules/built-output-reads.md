---
paths:
  - "packages/*/test/**"
  - "packages/*/src/**/*.test.*"
  - "packages/*/src/**/testing/**"
  - "packages/*/src/**/*test-helpers*"
  - "packages/*/package.json"
  - "packages/*/turbo.json"
  - "turbo.json"
  - "vitest.*setup.*"
  - "packages/*/vitest.*setup.*"
---

# A read of a package's `dist/` needs turbo to order its producer first

A test, test helper, vitest setup file or package script that builds a path into a workspace
package's `dist/` (its own included) needs a turbo task whose declared `outputs` cover that path,
glob matched whole, to be ordered before the reader's task: a `workspace:*` devDependency when the
producer is `build` and that makes no cycle, otherwise a `<pkg>#<task>` entry's `dependsOn` in
`turbo.json` — which REPLACES the generic task, so a `<pkg>#test:<tier>` entry keeps the generic's
`env`, `outputs` and `cache` equal and its `inputs` and `dependsOn` as a superset. A `dist` path
counts as resolved only when every piece is known and it lands exactly on a package's `dist/`;
any unknown piece, a case-only match, a `cwd`/shell launch, or a temp path a `..` climbs out of is
a finding at `file:line`: anchor it to a static repo location, or wrap a temp path in
`underTemp(path, tempRoot)` from `@vibe-agent-toolkit/utils/testing`. Path calls and temp sources
count only through their import. Out of scope, unchecked: product `src/` code a test calls, the
TypeScript files a script runs, and a bin run by name. What the rule scans, how it attributes
readers and producers, and how to wire an edge:
[`docs/writing-tests.md`](../../docs/writing-tests.md#reading-a-packages-built-output).
(enforced by: `validate-structure`, `checkBuiltOutputEdges`)
