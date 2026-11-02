### Fixed

- **`vat build` could run out of memory on a project with many plugin-local skills** (0.2.0-rc.12):
  validating each packaged skill re-read the whole project and kept every copy. It no longer re-reads
  it for every skill. If you raised `--max-old-space-size` to get past this, you can drop it.
- **A crawl that failed is retried, never replayed.** Inside one run, a later caller of the same project
  re-reads it under its own `unreadable` policy instead of inheriting the first caller's failure.
- **No crawl reads a build's staging residue.** The `.<name>.vat-staged-*` entries a build stages its
  output in are now in `NEVER_CRAWL_GLOBS`. A library build whose output sits inside the project but
  outside `dist/` no longer has one skill's staged copy validated as the next skill's project content.
- **`ResourceRegistry.crawl`'s default exclude is now `NEVER_CONTENT_GLOBS` + `BUILD_OUTPUT_GLOBS`.**
  0.1.42's default was `node_modules/`, `.git/` and `dist/`; it now also drops `.worktrees/`,
  `.claude/worktrees/` and a build's staging residue (`.<name>.vat-staged-*`), so a crawl from a
  repository root no longer lists every worktree's copy of the project. A directory merely named
  `coverage/`, `.test-output/` or `.turbo/` is still a member, as it was in 0.1.42. The projection's
  git extent changed to match: a git-held path (tracked, or untracked and not ignored) under such a
  name is now a member, where the rc releases pruned it; ignored territory is still pruned by the full
  `NEVER_CRAWL_GLOBS`, and so is the `filesystem` extent source, which has no ignore oracle.
  `NEVER_CONTENT_GLOBS` is exported from `@vibe-agent-toolkit/utils/crawl`.
