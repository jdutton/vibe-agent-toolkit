# Extending the monorepo: packages, utilities, schemas, CLI commands

The creation checklists that used to sit in the root `CLAUDE.md`. The root keeps the one guard that
must fire at creation time (the package-list registration); everything else is here.

## Adding a package

1. Create `packages/<name>/` with `package.json` (copy a sibling: the standard script set is
   asserted by `validate-structure`, so a hand-typed variant fails the gate), `tsconfig.json`
   extending `../../tsconfig.base.json` with `"composite": true`, `src/`, `test/`, and a `README.md`
   with usage examples.
2. Use `workspace:*` for every internal dependency.
3. Nothing to register: `private` in `package.json` decides whether it publishes, and the publish
   order is derived from workspace dependencies (`publishedPackagesInDependencyOrder()` in
   `packages/dev-tools/src/workspace-graph.ts`). tsconfig references are generated — run
   `bun run --cwd packages/dev-tools generate:tsconfig-refs` (see the next step).
4. Do **not** hand-edit `tsconfig.json` `references` (root or per-package): they are generated from
   workspace dependencies by `bun run generate:tsconfig-refs`, and `validate-structure` checks the
   committed file against the generator.
5. `bun install` to link workspace dependencies.
6. Pick the license field per the table in [`publishing.md`](../publishing.md#licensing-conventions).

Package-boundary rules: `utils` depends on no internal package and may carry external npm
dependencies (Zod, etc.); `resources`, `rag`, `agent-skills` depend on `utils`; `cli` orchestrates
the rest and owns no domain logic ([`packages/cli/CLAUDE.md`](../../packages/cli/CLAUDE.md)).
See [`architecture/README.md`](../architecture/README.md) for the full dependency shape.

## Adding a utility to `utils`

1. Identify the real need from another package — never add speculatively, and avoid string/array/
   object helpers without a concrete caller.
2. Add it under `packages/utils/src/`, with tests.
3. Export it from the barrel only if a package outside `utils` imports it; the barrel surface is
   pinned by `packages/utils/test/barrel-exports.test.ts`, so an addition is a deliberate diff.
4. Document it in `packages/utils/README.md`.

Path helpers follow the forward-slash convention in
[`packages/utils/CLAUDE.md`](../../packages/utils/CLAUDE.md).

## Adding a schema

Each package owns its schemas: define them with Zod under `src/schemas/` (`resources`,
`agent-skills`, `schema`) and export the TypeScript type as `z.infer<typeof XSchema>`. Strictness is
explicit on every `z.object` — `.strict()` by default, `.passthrough()` only where the schema parses
a document owned by someone else, with a comment naming that owner
(`.claude/rules/schema-strictness.md` fires when you touch one).

JSON Schema files are **generated and committed**, and a drift test pins each committed file to what
the generator emits:

| Package | Generator | Emits to |
|---|---|---|
| `schema` | `packages/schema/scripts/generate-json-schemas.ts` (`bun run generate:schemas`) | `packages/schema/schemas/*.json` |
| `agent-skills` | `packages/agent-skills/scripts/generate-json-schemas.ts` | `packages/agent-skills/schemas/*.json` |
| `resources` | `packages/dev-tools/src/generate-resources-json-schemas.ts` | `packages/resources/schemas/*.json` |

Each package's `build` script runs its generator, so a rebuilt package regenerates its schemas;
commit the regenerated `.json` beside the `.ts` change. There is no `*.schema.json` under any
`src/schemas/` directory.

## Adding a CLI command

1. Commander.js, in `packages/cli/src/commands/`; register the group in `bin.ts`.
2. Keep the command focused and composable; orchestrate other packages, never duplicate their
   logic — the walk, the merge, the validation live in the library package.
3. Help text follows `.claude/rules/cli-help-text.md` (fires when you edit a command file).
4. Every command exits `0` ok / `1` findings / `2` usage or system error, through the shared
   `ExitCode` enum and `handleCommandError`; a `--json` output registers its report schema.
5. Update [`command-lane-table.md`](command-lane-table.md) if the command reads the filesystem to
   build a population — the table is the bounded list of walkers.
6. Handle errors with a user-facing message that names the config mechanism that fixes it.
