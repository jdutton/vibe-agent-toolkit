---
paths:
  - "packages/utils/src/asset-reference.ts"
  - "packages/*/src/**/*config*.ts"
  - "packages/cli/src/commands/**"
  - "packages/resources/src/okf/**"
  - "packages/agent-skills/src/skill-source/**"
  - "packages/agent-skills/src/skill-test/**"
  - "packages/agent-skills/src/skill-packager.ts"
---

# A config-supplied file reference resolves through `resolveAssetReference` — never a parallel resolver

Every config-supplied "where is this file?" value — a schema path, a template path — resolves
through `resolveAssetReference(specifier, baseDir)` from `@vibe-agent-toolkit/utils` from day one.
It accepts filesystem paths (relative to `baseDir` or absolute) and npm bare specifiers
(`@scope/pkg/subpath`, honouring `exports`). Writing a path-only resolver beside it gives the same
config key two behaviours, one of which cannot see a package. (not enforced)

**Not for:** markdown URI-references (RFC 3986), dynamic JS imports (`dynamicImportPath()`),
`node_modules` enumeration walks, or CJS interop shims.

Call sites today — the templates for a new one (generated; regenerate with
`bun run generate:claude-md`, never edit between the markers):
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
