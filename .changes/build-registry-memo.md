### Fixed

- **`vat build` could run out of memory on a project with many plugin-local skills** (0.2.0-rc.12):
  validating each packaged skill re-read the whole project and kept every copy. It no longer re-reads
  it for every skill. If you raised `--max-old-space-size` to get past this, you can drop it.
- **A crawl that failed is retried, never replayed.** Inside one run, a later caller of the same project
  re-reads it under its own `unreadable` policy instead of inheriting the first caller's failure.
- **No crawl reads a build's staging residue.** The `.<name>.vat-staged-*` entries a build stages its
  output in are now in `NEVER_CRAWL_GLOBS`, and `ResourceRegistry.crawl` defaults to the same
  `NEVER_CRAWL_GLOBS` + `BUILD_OUTPUT_GLOBS` as every other crawl, rather than a shorter copy (it now
  also skips `coverage/`, `.test-output/`, worktrees and `.turbo/`). A library build whose output sits
  inside the project but outside `dist/` no longer has one skill's staged copy validated as the next
  skill's project content.
