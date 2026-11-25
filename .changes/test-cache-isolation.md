### Breaking

- **Library: `VAT_CACHE_DIR_ENV` moved from `@vibe-agent-toolkit/resources` to
  `@vibe-agent-toolkit/utils`.** Import it from `@vibe-agent-toolkit/utils`; the resources barrel no
  longer exports it.
- **Library: in a test process, `vatCacheRoot()` (`@vibe-agent-toolkit/resources`) refuses the
  machine-wide default `<tmpdir>/.vat-cache`.** When the test guard is armed
  (`VAT_TEST_USER_STATE_UNDER`, which this repository's vitest setup sets) and `VAT_CACHE_DIR` is
  unset, it throws rather than share one cache with the developer's own runs and every other test
  worker. Set `VAT_CACHE_DIR` to the test's own directory, or point `TMPDIR` (`TEMP` and `TMP` on
  Windows) at one. Outside a test process nothing changes.

### Added

- **Library: `refuseSharedTempState(root, what, remedy)` (`@vibe-agent-toolkit/utils`)**, the guard
  `vatCacheRoot()` uses: when the test guard is armed it throws for a directory directly in the temp
  directory, which every process on the machine shares, and returns `root` unchanged otherwise.
- **Library: `scratchTmpdirEnv` (`@vibe-agent-toolkit/utils/testing`) also unsets `VAT_CACHE_DIR`**
  for the test, so the VAT cache lives in the scratch and is removed with it.
