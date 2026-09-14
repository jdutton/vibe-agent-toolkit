# @vibe-agent-toolkit/dev-tools

Development tooling for the monorepo — private, never published. Every tool is TypeScript under
`src/` (never a shell script) and is held to the same quality bar as shipped code: lint, typecheck,
duplication, unit tests. The root `package.json` `scripts` block is the index of what runs them;
`bun run <script>` from the repo root is the way to invoke one.

## Scripts

Every top-level script under `src/`, by basename (generated from the directory; regenerate with
`bun run generate:claude-md`, never edit between the markers):

<!-- gen:dev-tools-scripts -->
`audit-quality-gate`, `bump-version`, `changelog-fragments`, `check-test-heap-budget`,
`clean-build`, `comment-density-ceilings`, `comment-density`, `common`, `contraband-scan`,
`copy-yaml-assets`, `derived-artifact-rules`, `determine-publish-tags`, `duplication-check`,
`eslint-rules-table`, `extract-changelog`, `fix-workspace-deps`, `generate-claude-md`,
`generate-python-stdlib`, `generate-resources-json-schemas`, `generate-tsconfig-refs`,
`generate-workflow`, `import-marketplace`, `index`, `jscpd-check-new`, `jscpd-update-baseline`,
`link-all`, `link-workspace-packages`, `markdown-it-parser`, `parser-bakeoff`, `pin-barrel-exports`,
`pin-emitted-schemas`, `pre-publish-check`, `prepare-bin`, `print-failed-step-output`,
`process-test-images`, `publish-with-rollback`, `resolve-workspace-deps`, `runtime-test-helpers`,
`structure-finding`, `test-tier-budget-allowlist`, `test-tier-budget-reporter`,
`test-tier-budget-seed`, `tsc-clean-build`, `unlink-all`, `unused-exports-allowlist`,
`unused-exports`, `validate-repo-structure`, `validate-version`, `workspace-graph`
<!-- /gen:dev-tools-scripts -->

## Where the rules they enforce are stated

- The repository's structural rules (`validate-repo-structure`, `derived-artifact-rules`): root
  [`CLAUDE.md`](../../CLAUDE.md) states each rule with its enforcer.
- Generated blocks in `CLAUDE.md`, `.claude/rules/asset-references.md` and this file:
  `generate-claude-md` owns what sits between `<!-- gen:… -->` markers; `--check` runs in the gate.
- Ratchets (duration budgets, comment density, unused exports, directive counts): each carries its
  allowlist beside it under `src/`, asserted both ways — a stale entry is a failure, not a leftover.
- Adding a tool: a new `src/<name>.ts` with `isEntrypoint`-guarded `main()` returning an
  `ExitCode`, a `scripts` line in the root `package.json`, and a unit test under `test/`;
  [`docs/contributing/extending-the-monorepo.md`](../../docs/contributing/extending-the-monorepo.md).
