---
paths:
  - "packages/*/package.json"
  - "packages/*/LICENSE"
---

# The `license` field, `private`, and the `LICENSE` file move together

- Open-source package: `"license": "MIT"` + a `LICENSE` file.
- Proprietary package: `"license": "SEE LICENSE IN LICENSE"` + `"private": true` + a `LICENSE` file.
- `"UNLICENSED"` only for a package not yet licensed — npm tooling reads it as "the author forgot",
  so it is never the value for an intentionally proprietary package.

Table and the proprietary `LICENSE` template:
[`docs/publishing.md`](../../docs/publishing.md#licensing-conventions). (not enforced)

Also in this file: `private` alone decides whether the package publishes, and the publish order is
derived from `workspace:*` dependencies (`packages/dev-tools/src/workspace-graph.ts`) — there is no
list to register a package in. `vat.skills` is a packaging hint that `vat verify` checks and
`vat build` never reads.
