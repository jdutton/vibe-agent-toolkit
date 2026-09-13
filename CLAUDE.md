# Project Development Guidelines

Rules for anyone (human or agent) working on vibe-agent-toolkit — a TypeScript monorepo for
building, testing and distributing portable AI agents and skills. Architecture and every how-to
live in [`docs/`](docs/README.md); this file carries only rules that prevent a specific mistake.
**Convention: every rule here ends with `(enforced by: <check>)` or `(not enforced)`** — if you add
a rule, tag it; if you add an enforcer, retag the rule.

## Pre-1.0 policy — backward compatibility is a bug

While the version is 0.x: no compatibility layers, no deprecation shims, no re-exports "for
convenience", no old API kept beside a new one. Make the breaking change, delete the old code, force
consumers to update, and record it under `Breaking` in the changelog. Semantic versioning with
deprecation cycles starts at 1.0. (not enforced)

## No version constants — the npm package version is the only version

No hand-maintained integer decides whether stored data is still valid: no `CACHE_VERSION`,
`SCHEMA_VERSION`, `*_REVISION`, no `z.literal(<n>)` on a `version` field, no `schema:`/`v1alpha`
label in VAT's own output. Derive the fact from the shape itself (a digest of the schema's
declaration, as `parseFactsShapeSource()` does), validate with a `.strict()` schema, or invalidate
explicitly by deleting the stored artifact. Any PR that introduces one must say so under its own
heading so it is removed before merge. Not offenders: an external API header value, a real list of
supported versions, a regex that parses versions, a `VERSION` string in a test fixture. Rationale:
[`docs/contributing/no-version-constants.md`](docs/contributing/no-version-constants.md).
(enforced by: `local/no-version-literal` for the integer shapes; labels and the PR heading are not)

## Paths, imports, asset references

- Use `safePath.join/resolve/relative` from `@vibe-agent-toolkit/utils` — never raw `node:path`
  `join/resolve/relative`; they always return forward slashes. Separator conventions:
  [`packages/utils/CLAUDE.md`](packages/utils/CLAUDE.md). (enforced by: `local/no-raw-node-path`)
- `yaml` is the one YAML library; `js-yaml`, `gray-matter` and `front-matter` are banned. Frontmatter
  writes go through `openFrontmatter` from `@vibe-agent-toolkit/resources`. The approved-library
  list is owned by `noRestrictedImportsConfig` in `eslint.config.js`, not by any doc.
  (enforced by: `no-restricted-imports`)
- Every config-supplied "where is this file?" value — a schema path, a template path — resolves
  through `resolveAssetReference(specifier, baseDir)` from `@vibe-agent-toolkit/utils` from day one;
  never write a parallel path-only resolver. It accepts filesystem paths (relative to `baseDir` or
  absolute) and npm bare specifiers (`@scope/pkg/subpath`, honouring `exports`). Not for markdown
  URI-references (RFC 3986), dynamic JS imports (`dynamicImportPath()`), `node_modules` enumeration
  walks, or CJS interop shims. (not enforced)

  Call sites today — the templates for a new one:
  <!-- gen:asset-reference-sites -->
  - `packages/agent-skills/src/skill-packager.ts`
  - `packages/agent-skills/src/skill-source/sources/npm-source.ts`
  - `packages/agent-skills/src/skill-source/sources/path-source.ts`
  - `packages/agent-skills/src/skill-test/run-harness.ts`
  - `packages/cli/src/commands/doctor.ts`
  - `packages/cli/src/commands/resources/validate.ts`
  - `packages/cli/src/commands/skill/test/run.ts`
  - `packages/resources/src/okf/config.ts`
  - `packages/resources/src/projection/contributors/package-extent.ts`
  - `packages/resources/src/resource-registry.ts`
  <!-- /gen:asset-reference-sites -->

## Skill distribution boundaries

- `SKILL.md` frontmatter carries only the portable skill schema — never a VAT-specific field. All
  VAT config (discovery globs, packaging, `publish`, plugin membership) lives in
  `vibe-agent-toolkit.config.yaml`. (not enforced)
- `package.json` `vat.skills` is a packaging hint that `vat verify` checks and `vat build` never
  reads. (enforced by: `vat verify` consistency-check)
- `publish: false` opts a skill out of the distribution-consistency checks only; it is still
  discovered, built and held to every packaging rule. (enforced by: `vat build`)
- Error messages name the config mechanism that fixes them. (not enforced)

Roles table: [`docs/architecture/skill-packaging.md`](docs/architecture/skill-packaging.md#who-owns-what-skillmd-configyaml-packagejson).

## Monorepo layout and build

Bun workspaces, `tsc --build` (every package `composite: true`, internal deps `workspace:*`), Vitest,
ESLint, vibe-validate, GitHub Actions (Node 24 × Ubuntu/Windows) — [`docs/build-system.md`](docs/build-system.md).
`utils` depends on no internal package; the direction is utils → resources → rag/agent-skills → cli;
`cli` orchestrates, never owns domain logic ([`packages/cli/CLAUDE.md`](packages/cli/CLAUDE.md)).
(enforced by: `bun run typecheck` for the build wiring; the direction is not enforced)

<!-- gen:packages-tree -->
| Package | Ships | Purpose |
|---|---|---|
| `agent-config` | yes | Agent manifest loading and validation |
| `agent-runtime` | yes | Runtime framework for building and executing portable AI agents |
| `agent-skills` | yes | Build, validate, and package agent skills in the Agent Skills format |
| `claude-marketplace` | yes | Claude plugin marketplace tools: compatibility analysis, provenance tracking, enterprise config |
| `cli` | yes | Command-line interface for vibe-agent-toolkit |
| `dev-tools` | private | Development tools for the monorepo |
| `discovery` | yes | Intelligent file discovery for VAT agents and Agent Skills |
| `gateway-mcp` | yes | MCP Gateway for exposing VAT agents through Model Context Protocol |
| `lab` | private | Quality lab: generate and compare analyzable reports across projects, project versions, and vat versions |
| `projection-sqlite` | yes | SQLite-backed projection store for VAT, on Node's built-in node:sqlite |
| `rag` | yes | Abstract RAG (Retrieval-Augmented Generation) interfaces and shared implementations |
| `rag-lancedb` | yes | LanceDB implementation of RAG interfaces for vibe-agent-toolkit |
| `resource-compiler` | yes | Compile markdown resources to TypeScript with full IDE support |
| `resources` | yes | Markdown resource parsing, validation, and link integrity checking |
| `runtime-claude-agent-sdk` | yes | Claude Agent SDK runtime adapter for VAT agents |
| `runtime-langchain` | yes | LangChain.js runtime adapter for VAT agents |
| `runtime-openai` | yes | OpenAI SDK runtime adapter for VAT agents |
| `runtime-vercel-ai-sdk` | yes | Vercel AI SDK runtime adapter for VAT agents |
| `schema` | yes | JSON Schema definitions and TypeScript types for VAT agent manifest format |
| `test-agents` | private | Simple test agents for validating runtime adapters (internal use only) |
| `transports` | yes | Transport adapters for VAT conversational agents |
| `utils` | yes | Core utility functions shared across the vibe-agent-toolkit packages |
| `vat-development-agents` | yes | VAT development agents - dogfooding the vibe-agent-toolkit |
| `vat-example-cat-agents` | yes | Example agents: quirky cat agents demonstrating VAT patterns |
| `vibe-agent-toolkit` | yes | Modular toolkit for building, testing, and deploying portable AI agents |
<!-- /gen:packages-tree -->

**Adding a package**: `packages/<name>/` with `package.json`, `tsconfig.json` extending
`../../tsconfig.base.json` with `composite: true`, `src/`, `test/`, `README.md`; nothing to
register — `private` decides whether it publishes and the publish order is derived from workspace
deps (`workspace-graph.ts`); run `bun install`. `tsconfig.json` `references` are generated from
workspace deps — do not hand-edit. Walkthrough:
[`docs/contributing/extending-the-monorepo.md`](docs/contributing/extending-the-monorepo.md).
(enforced by: `validate-structure` for the scripts and the generated `references`; the rest is not)

## Code standards

- TypeScript ES2024 / NodeNext / strict with `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `exactOptionalPropertyTypes` (`tsconfig.base.json`). (enforced by: `bun run typecheck`)
- ESLint zero warnings; cognitive complexity ≤ 15 in `src`, ≤ 20 in `test`; `no-explicit-any` is an
  error in `src` and off in `test`; every `eslint-disable` directive carries a description.
  Custom rules live in `packages/utils/eslint/` — see
  [`docs/custom-eslint-rules.md`](docs/custom-eslint-rules.md). (enforced by: `bun run lint`)
- **Zero code duplication.** When `duplication-check` fails, refactor — extract to a shared helper.
  Never run `duplication-update-baseline` or edit `.github/.jscpd-baseline.json` without the
  owner's explicit permission; the baseline tracks progress to zero, it does not accept new
  duplication. (enforced by: `bun run duplication-check`)
- SonarCloud runs automatic analysis: fix every smell it reports; **never `NOSONAR`**, never argue
  one away (suppression does not work under automatic analysis). In its PR comment, New, Accepted
  and Security Hotspots must all be zero — "Quality Gate passed" is not zero. Ignore its "Coverage
  on New Code" line ([why](docs/contributing/traps.md#sonarcloud-coverage-on-new-code-is-always-zero));
  Codecov is the coverage authority. (not enforced)
- Coverage thresholds in `vitest.config.ts` are a self-raising ratchet (`thresholds.autoUpdate`,
  whole points), currently 82/77/86/82 % over ALL of `src` (enforced by: `coverage.yml`). Never
  lower one by hand. (not enforced)
- Licensing: open-source packages `"MIT"` + `LICENSE`; proprietary `"SEE LICENSE IN LICENSE"` +
  `"private": true` + `LICENSE`; `"UNLICENSED"` only for a package not yet licensed. Template in
  [`docs/publishing.md`](docs/publishing.md#licensing-conventions). (not enforced)

## Testing

Read [`docs/writing-tests.md`](docs/writing-tests.md) before writing any test — it owns the test
pyramid, the helper-extraction rule, fixture storage, and the per-FILE duration budget
(`test-tier-budget-reporter`, shrink-only allowlist; not on Windows).

- **Never `bun test`** — it ignores `vitest.config.ts` and runs every tier in one process. Use
  `bun run validate` or `bun run test:<tier>`. Only unit tests are coverage-instrumented.
  (not enforced)
- Run a single integration/system file from its **package** directory, never the repo root (the root
  config collects 0 files and exits 0):
  `cd packages/<pkg> && bunx vitest run --config vitest.integration.config.ts test/integration/<file>`.
  (not enforced)
- Extract pure logic so it can be unit-tested; keep I/O thin and cover it with integration tests.
  (not enforced)

### Test Fixtures Convention

Committed fixtures never use gitignored names (`dist/`, `node_modules/`, `coverage/`, `build/`) —
`git add` silently skips them, so they vanish in a clean clone. Store under e.g. `build-artifacts/`
and copy in `beforeAll`. (not enforced)

## Workflow — the gate

1. Work on a feature branch, never on `main`. (not enforced)
2. Batch related changes; then loop `bun run validate` until it passes with zero errors. It is the
   FULL tier and always executes (it carries `--force`); turbo's per-package cache makes an
   unchanged tree cheap (~40 s warm), not instant.
   (enforced by: `vibe-validate.config.yaml` + `package.json` `scripts.validate`)
3. **Trust the exit code, not the summary.** `bun run validate` never replays vibe-validate's cache.
   The pre-commit HOOK does, and a cached hook verdict is a pre-commit-TIER verdict — never a full
   one. A real full run is minutes; a sub-second "pass" means nothing ran. Never read a verdict
   through a pipe (`validate | tail` reports `tail`'s status): redirect to a file and capture `$?`.
   (not enforced)
4. Ask before committing: present what changed and that validation passed. Conventional-commit
   messages. (not enforced)

**The gate has two tiers** (enforced by: `runScope: ci` in `vibe-validate.config.yaml`):
- **pre-commit tier** — `git commit` (Husky → `vibe-validate pre-commit`) runs build, typecheck,
  lint, duplication and unit tests only (~66 s warm on macOS); every other step is `runScope: ci`.
- **full tier** — `bun run validate` and CI run every step: the above plus knip, repo structure,
  publish readiness, link validation, the `vat` dogfood steps, integration and system tests. It sets
  `CI=1` (vibe-validate's only `runScope` switch) and `--force` (the tree-hash cache records a
  skipped step as passed, so it cannot tell the tiers apart).
- **A green commit is NOT a green PR.** Run `bun run validate` before pushing; CI runs the full
  tier on ubuntu and Windows.

**Subagent-driven execution — batch, validate once.** `git commit` runs the pre-commit tier (~66 s
warm, ~130 s cold on macOS); the full gate costs minutes to over an hour uncached; a mid-refactor
tree is never all-green for either. So: do not commit per task, do not run `bun run validate`
mid-flight. Batch every task into one uncommitted tree, validate once when stable, fix, commit at
the end. Each "move/rename" task deletes the original in the same task (duplication is caught only
at that final gate). Give every implementer subagent this contract: (not enforced)

> Verify with the fast isolated signal only: `bunx eslint <changed files> --max-warnings=0` and
> `bunx vitest run <path/to/file.test.ts>` (or `bun run test:unit -- <substring>`). Do NOT run
> `bun run validate`, `test:system`, `test:integration` or `bun test`. Do NOT commit.

**Before a pull request:** add the changelog entry — prefer a `.changes/<topic>.md` fragment (see
`.changes/README.md`; `bump-version` folds it) over editing `CHANGELOG.md` `[Unreleased]` directly,
adopter-visible wording per `.claude/rules/changelog-adopter-visible.md`; ask the developer *"bump the version or cut
an RC for this change?"* (`bun run bump-version <version>`; a stable bump stamps `[Unreleased]`, an
RC stays there); run `bun run validate` once more. (not enforced)

**Before tagging a release:** `bun run pre-release` must pass (CHANGELOG stamped, no stale remote
tags, marketplace dry-run); only then `git tag v<version>` and `git push origin main v<version>` —
the tag push triggers `publish.yml`. Rollback: [`docs/publishing.md`](docs/publishing.md).
(enforced by: `bun run pre-release`, `publish.yml`)

**Three "validate" commands — do not conflate them:** `bun run validate` is this repo's gate (full
tier, `CI=1 --force`; the hook runs the smaller tier); `vat validate` runs source-level validators
on an adopting project; `vat verify` validates built `dist/` artifacts. During development run
`bun run vat <command>` from the repo root (workspace bin linking is unreliable). (not enforced)

## Measuring anything — the lab is the instrument

"Why is this slow", "how many files does it touch", "did this regress" all route to `packages/lab`
first (`vat-lab <facet> run|compare`; `DEFAULT_MEASURED_COMMANDS` is open — pass your own specs).
Never hand-roll a probe: it measures once and is never reviewed. If the lab cannot see the code,
that is the finding — extend it or say so.
[`packages/lab/README.md`](packages/lab/README.md), [scope](packages/lab/docs/scope.md). (not enforced)

## Demos

Every demo goes through a runtime adapter and supports every compatible runtime — never direct
agent execution. Example: `packages/vat-example-cat-agents/examples/conversational-demo.ts`;
patterns: [`docs/demo-guidelines.md`](docs/demo-guidelines.md). (not enforced)

## Agent-facing skills for VAT work

`packages/vat-development-agents/resources/skills/` ships the `vibe-agent-toolkit` plugin. **When a
task matches a row, load the skill before acting** — `docs/` is reference; these are the runbooks.
Editing one reds the golden drift test in the last validate phase; regenerate the golden in the same
edit (steps in that directory's `CLAUDE.md`) and read the diff — it must be exactly your edit.
(enforced by: `packaged-output-drift.system.test.ts`)

<!-- gen:skills-table -->
| Skill | Use when |
|---|---|
| `vibe-agent-toolkit` (`SKILL.md`) | Starting VAT work or deciding which sub-skill applies — the router; load it first |
| `coherence-audit` | Auditing a codebase for COHERENCE rather than bugs — does every lane implement one contract, does a status tell the truth, is a passing test suite blind |
| `markdown-rewriting` | Programmatic markdown/frontmatter edits — moving files, updating references, schema-evolution migrations; comment-preserving FrontmatterEditor + rewriteBodyLinks |
| `vat-adoption-and-configuration` | New project setup, `vibe-agent-toolkit.config.yaml` orientation, repo structure, vibe-validate integration, npm postinstall |
| `vat-agent-authoring` | TypeScript agent archetypes, `agent.yaml`, result envelopes, orchestration, runtime adapters |
| `vat-audit` | `vat audit` on plugins, marketplaces, skills, or settings — including `--compat`, `--exclude`, `--user`, CI use |
| `vat-enterprise-org` | Anthropic Admin API: org users, cost/usage, workspace skills, `ANTHROPIC_ADMIN_API_KEY` |
| `vat-knowledge-resources` | Markdown collections, `resources:` config, frontmatter schema validation, `vat resources validate` · Asking the resource projection SQL questions (`vat resources query`) or declaring standing SQL assertions that gate CI (`vat resources check`, `--budget`) |
| `vat-rag` | `vat rag index` / `vat rag query`, **installing the opt-in RAG backends**, embedding providers, vector stores, chunking |
| `vat-skill-authoring` | Writing or revising a SKILL.md — frontmatter, body, references, packagingOptions, validation overrides |
| `vat-skill-distribution` | `vat build`, `vat verify`, plugin/marketplace layout, npm publishing, postinstall |
| `vat-skill-review` | Pre-publication quality review, `vat skill review`, validation-code triage |
| `vat-skill-testing` | Behaviorally testing a packaged skill in isolation — `vat skill test run`/`configure`, friction triage, auth modes, security caveats |
<!-- /gen:skills-table -->

## Where the rest lives

- [`docs/README.md`](docs/README.md) indexes every doc. Working on VAT itself:
  [`docs/contributing/`](docs/contributing/) — route new prose per `content-routing.md`; a
  failure that looks like something else goes in `traps.md`.
  <!-- gen:contributing-docs -->
  `baseline-control-adopter-response.md`, `command-lane-table.md`, `content-routing.md`,
  `cowork-driver-spike.md`, `extending-the-monorepo.md`, `no-version-constants.md`,
  `plugin-distribution-findings.md`, `traps.md`, `vat-debugging.md`, `vat-install-architecture.md`,
  `vat-linkauth-contributing.md`
  <!-- /gen:contributing-docs -->
- Subtree-scoped rules fire from `.claude/rules/*.md` (`paths:` globs).
- External vendor guidance is cached under [`docs/external/`](docs/external/) with source URL and
  fetch date; `@vendor-claim reviewed=<date>` stamps in code are re-verified within 90 days.
  (enforced by: `validate-structure` Rule 11, at `warning`)
- Dev tooling is TypeScript under `packages/dev-tools/src/` (never shell scripts), same quality bar:
  <!-- gen:dev-tools-scripts -->
  `audit-quality-gate`, `bump-version`, `changelog-fragments`, `check-test-heap-budget`,
  `clean-build`, `comment-density-ceilings`, `comment-density`, `common`, `contraband-scan`,
  `copy-yaml-assets`, `derived-artifact-rules`, `determine-publish-tags`, `duplication-check`,
  `extract-changelog`, `fix-workspace-deps`, `generate-claude-md`, `generate-python-stdlib`,
  `generate-resources-json-schemas`, `generate-tsconfig-refs`, `generate-workflow`,
  `import-marketplace`, `index`, `jscpd-check-new`, `jscpd-update-baseline`, `link-all`,
  `link-workspace-packages`, `markdown-it-parser`, `parser-bakeoff`, `pin-barrel-exports`,
  `pin-emitted-schemas`, `pre-publish-check`, `prepare-bin`, `process-test-images`,
  `publish-with-rollback`, `resolve-workspace-deps`, `runtime-test-helpers`, `structure-finding`,
  `test-tier-budget-allowlist`, `test-tier-budget-reporter`, `test-tier-budget-seed`,
  `tsc-clean-build`, `unlink-all`, `unused-exports-allowlist`, `unused-exports`,
  `validate-repo-structure`, `validate-version`, `workspace-graph`
  <!-- /gen:dev-tools-scripts -->
- [Architecture](docs/architecture/README.md) · [Best practices](docs/best-practices.md) ·
  [Structured outputs](docs/structured-outputs.md) · CI: `.github/workflows/validate.yml`.
