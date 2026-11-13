### Added

- **`@vibe-agent-toolkit/resources` exports the filesystem extent's condition codes**:
  `EXTENT_DIRECTORY_UNLISTABLE`, `EXTENT_SYMLINK_NOT_REALIZED`, `EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT`,
  `EXTENT_SYMLINK_TARGET_UNREADABLE` and `EXTENT_SYMLINK_TARGET_UNRESOLVED`.
- **`@vibe-agent-toolkit/utils/testing` adds `expectAbsenceCause`**, which asserts that a projection's
  rows carry a given absence cause (a condition code, optionally qualified by extent kind, or a
  content state), with `absenceObservations` and `matchesAbsenceCause` beside it.
