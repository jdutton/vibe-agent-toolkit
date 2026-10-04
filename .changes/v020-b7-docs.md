### Added

- **`findExecutable(name)` on `@vibe-agent-toolkit/utils/testing`** returns the absolute path of a
  binary found by walking `PATH` once, or `undefined` instead of a throw, so a test can skip when
  the tool is absent. It is the non-throwing sibling of `resolveExecutable(name)`.
