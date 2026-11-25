### Fixed

- **The types of `@vibe-agent-toolkit/utils/eslint` are now assignable to ESLint's `Plugin`.** A
  rule's `create` was declared to return `Record<string, unknown>`, which ESLint's rule-visitor
  type rejects, so passing the plugin to a typed `plugins:` entry in an `eslint.config.ts` failed to
  compile.
