# Subagent-driven execution — batch every task, validate once, commit once

The root [`CLAUDE.md`](../../CLAUDE.md) states the rule; this page holds why it is shaped that
way and the contract to hand each implementer.

## Why one tree, one gate, one commit

- `git commit` runs the pre-commit tier of the gate (build, typecheck, lint, duplication, unit
  tests — roughly a minute warm, twice that cold on macOS). A commit per task pays that per task.
- The full gate (`bun run validate`) costs minutes to over an hour uncached, and a mid-refactor
  tree is never all-green for either tier: half-moved code reds duplication, half-migrated callers
  red typecheck.
- Duplication is judged by the gate over the whole tree, never by the per-file signal an
  implementer runs. A "move/rename" task that leaves the original behind for a later task is a
  clone until that task runs; each such task deletes the original in the same task.

So: batch every task into one uncommitted tree, validate once when the tree is stable, fix what
the gate reports, and commit at the end. Do not commit per task; do not run `bun run validate`
mid-flight.

## The contract to give every implementer subagent

Paste it verbatim into the brief; a subagent that is not told this will run the whole gate, or
commit, because both look like diligence:

> Verify with the fast isolated signal only: `bunx eslint <changed files> --max-warnings=0` and
> `bunx vitest run <path/to/file.test.ts>` (or `bun run test:unit -- <substring>`). Do NOT run
> `bun run validate`, `test:system`, `test:integration` or `bun test`. Do NOT commit.

For a file under `test/integration/` or `test/system/`, the single-file run must be made from the
package directory with that tier's config
([`.claude/rules/integration-and-system-tests.md`](../../.claude/rules/integration-and-system-tests.md)).

## Waves, ownership and the reconciliation pass

- Dispatch tasks in parallel waves with disjoint file ownership; a shared file (a barrel, the root
  `package.json`, `eslint.config.js`) is owned by one task and the others send it a request.
- An implementer's clean verification predates its last edit — an edit asked for mid-flight lands
  after its lint run. Repeat the contract with the ask, and smoke-build between waves.
- A subagent's report is a claim, not a verdict: `git status` before trusting "done", and re-run
  the file it names before trusting "green".
- One reconciliation task per wave applies every cross-task request, regenerates the derived
  artifacts (`bun run generate:claude-md`, `generate:tsconfig-refs`, emitted schemas, goldens) and
  runs the cheap whole-tree checks before the gate.

## After the gate

The gate's verdict belongs to the tree hash it ran on. A doc edit after a green gate is a different
tree — either re-run the gate or run every step that reads what changed, and say which.
Committing and the pull request: [`pull-request-checklist.md`](pull-request-checklist.md).
