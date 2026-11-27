# @vibe-agent-toolkit/dev-tools

Development tooling for the monorepo — private, never published. Every tool is TypeScript under
`src/` (never a shell script) and is held to the same quality bar as shipped code: lint, typecheck,
duplication, unit tests. The root `package.json` `scripts` block is the index of what runs them;
`bun run <script>` from the repo root is the way to invoke one.

## Scripts

Every top-level script under `src/`, by basename (generated from the directory; regenerate with
`bun run generate:claude-md`, never edit between the markers):

<!-- gen:dev-tools-scripts -->
`audit-quality-gate`, `built-output-edges`, `built-output-paths`, `built-output-scan`,
`bump-version`, `changelog-fragments`, `check-test-heap-budget`, `clean-build`,
`comment-density-ceilings`, `comment-density`, `common`, `contraband-scan`, `copy-yaml-assets`,
`derived-artifact-rules`, `determine-publish-tags`, `duplication-check`, `eslint-rules-table`,
`extract-changelog`, `fix-workspace-deps`, `generate-claude-md`, `generate-lint-config`,
`generate-python-stdlib`, `generate-resources-json-schemas`, `generate-tsconfig-refs`,
`generate-workflow`, `import-marketplace`, `index`, `jscpd-check-new`, `jscpd-update-baseline`,
`known-defects-gate`, `link-all`, `link-workspace-packages`, `markdown-it-parser`,
`npm-registry-guard`, `osv-ignore-register`, `osv-ignore-scan`, `override-register`,
`parser-bakeoff`, `pin-barrel-exports`, `pin-emitted-schemas`, `pre-publish-check`, `prepare-bin`,
`print-failed-step-output`, `publish-with-rollback`, `resolve-workspace-deps`, `run-vat`,
`structure-finding`, `test-tier-budget-allowlist`, `test-tier-budget-reporter`,
`test-tier-budget-seed`, `tsc-clean-build`, `unlink-all`, `unused-exports-allowlist`,
`unused-exports`, `validate-repo-structure`, `validate-version`, `vendor-typescript`,
`work-counter-register`, `workspace-graph`
<!-- /gen:dev-tools-scripts -->

## Upgrading the vendored TypeScript

`vendor-typescript` copies the `typescript` that `resources` pins into `resources`' build, so a
TypeScript upgrade is a parser change. The owner holds it on the 6.0.x line: Dependabot raises
patches alone, in their own group, and ignores minors and majors.

- **Move together:** `devDependencies.typescript` in the root `package.json`,
  `packages/dev-tools/package.json` and `packages/resources/package.json`, each one exact version,
  then `bun install`. `single-typescript.test.ts` fails on any other shape, and the script refuses
  to vendor a resolved copy that differs from `resources`' pin.
- **Re-measure:** the install size in `packages/resources/README.md` (`npm pack --dry-run --json`
  with and without `dist/vendor`), and the pin test's first load against its tier's per-file budget.
- **Re-check:** that `lib/typescript.js` still ends in the one `//# sourceMappingURL=` line the
  script strips, and that `packages/resources/src/vendor/ATTRIBUTION.md` still describes the
  modification; that upstream still ships no NOTICE file; that every function the pin test
  (`vendored-typescript-pin.integration.test.ts`) lists is still there; that no code hard-codes a
  TypeScript enum value; and that the tool peer ranges in `bun.lock` (`@typescript-eslint/*`,
  `eslint-plugin-sonarjs`, `knip`) admit the new version.

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
