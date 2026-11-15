### Fixed

- **`vat skill test` could grade an eval with input `files` as a skill failure because the executor
  looked for those files in the wrong directory.** The executor prompt now names the staged skill as
  supporting tools and reference material, and names the eval's working directory as the place its
  files are. Re-run affected suites; no config change needed.
