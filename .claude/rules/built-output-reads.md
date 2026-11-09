---
paths:
  - "packages/*/test/**"
  - "packages/*/src/**/*.test.*"
  - "packages/*/src/**/testing/**"
  - "packages/*/src/**/*test-helpers*"
  - "packages/*/package.json"
  - "turbo.json"
---

# A read of a package's `dist/` needs turbo to order its producer first

A test, test helper or package script that builds a path into a workspace package's `dist/` (its
own included) needs a turbo task whose declared `outputs` cover that path to be ordered before the
reader's task: a `workspace:*` devDependency when the producer is `build` and that makes no cycle,
otherwise a `<pkg>#<task>` entry's `dependsOn` in `turbo.json` — which REPLACES the generic task,
so a `<pkg>#test:<tier>` entry repeats its `env`, `outputs`, `inputs`, `cache` and `dependsOn`.
A path built from something the scan cannot follow is a finding at `file:line`: anchor it to a
static repo location, or wrap a temp path in `underTemp(path, tempRoot)` from
`@vibe-agent-toolkit/utils/testing`. A script that runs a bin by name (`vat …`) is out of scope: a
bin resolves only through a declared dependency, which `^build` already orders. What the rule
scans, how it attributes readers and producers, and how to wire an edge:
[`docs/writing-tests.md`](../../docs/writing-tests.md#reading-a-packages-built-output).
(enforced by: `validate-structure`, `checkBuiltOutputEdges`)
