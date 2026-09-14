---
paths:
  - "tsconfig.json"
  - "tsconfig.base.json"
  - "packages/*/tsconfig.json"
---

# `tsconfig.json` `references` are generated from workspace deps — never hand-edit them

Every package's `tsconfig.json` extends `../../tsconfig.base.json` with `composite: true` (the
`composite` half is enforced by `tsc --build` for every referenced package; the `extends` half is
not enforced), and its `references` list is derived from the `workspace:*` dependencies in its
`package.json` by `packages/dev-tools/src/workspace-graph.ts`. A hand-edited list is overwritten
and, until then, reds the gate. (enforced by: `validate-structure`, for `references` only)

- Adding or removing an internal dependency: edit `package.json`, then
  `bun run generate:tsconfig-refs`.
- Adding a package: [`docs/contributing/extending-the-monorepo.md`](../../docs/contributing/extending-the-monorepo.md).
- The compiler options themselves (`ES2024`, `NodeNext`, `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `exactOptionalPropertyTypes`) live once, in `tsconfig.base.json`; a
  per-package override is a second contract for the same rule.
