# Attribution

This directory vendors **TypeScript** by Microsoft, licensed under Apache-2.0.

- Upstream: https://github.com/microsoft/TypeScript (npm package `typescript`)
- Version: the exact version packages/resources/package.json pins in `devDependencies.typescript`; this copy is that package's `lib/typescript.js`, written here by the build (packages/dev-tools/src/vendor-typescript.ts).
- License: see ./LICENSE.txt (Apache-2.0, copied verbatim from the package at build)
- Third-party notices: see ./ThirdPartyNoticeText.txt (copied verbatim from the package at build)

TypeScript ships no NOTICE file; per Apache-2.0 Section 4(d) no NOTICE-propagation
obligation exists, and this file is intentionally NOT named NOTICE.

Modified vendored files (Apache-2.0 Section 4(b)):

- `typescript.cjs`: the package's `lib/typescript.js`, renamed to `.cjs`, with its last line
  `//# sourceMappingURL=typescript.js.map` removed. Every other byte is unchanged.

`typescript.d.cts` is VAT's own declaration for the copy, not an upstream file.
