### Changed

- **`@vibe-agent-toolkit/resources` now ships a copy of TypeScript 6.0.3, with its licence and
  notice**, so the package grows (sizes in its README). Nothing loads it yet; no action needed.

### Fixed

- **The `content-key-opaque` ESLint rule, shipped on `@vibe-agent-toolkit/utils/eslint`, went blind
  under TypeScript 6.0 and reported nothing.** It now reads type flags from the program's own
  checker; no action needed.
