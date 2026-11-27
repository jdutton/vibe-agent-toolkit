### Changed

- **`@vibe-agent-toolkit/resources` now ships a copy of TypeScript 6.0.3, with its licence, notice
  and attribution**, so the package grows (sizes in its README), and its `license` is now
  `MIT AND Apache-2.0`. Dependency scanners cannot see the copy (see the README). Nothing loads it
  yet; no action needed.

### Fixed

- **The `content-key-opaque` ESLint rule, shipped on `@vibe-agent-toolkit/utils/eslint`, stopped
  seeing `never` types and the key slots inside objects, arrays and records under TypeScript 6.0**,
  whose values for those two type flags moved; its `any` and `unknown` checks were unaffected. It now reads type flags from the program's own checker; no
  action needed.
