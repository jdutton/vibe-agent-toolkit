### Added

- **`@vibe-agent-toolkit/resources` exports the filesystem extent's condition codes**:
  `EXTENT_DIRECTORY_UNLISTABLE`, `EXTENT_SYMLINK_NOT_REALIZED`, `EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT`,
  `EXTENT_SYMLINK_TARGET_UNREADABLE` and `EXTENT_SYMLINK_TARGET_UNRESOLVED`.
- **`@vibe-agent-toolkit/utils/testing` adds `expectAbsenceCause`**, which asserts that a projection's
  rows carry a given absence cause (a condition code, optionally qualified by extent kind and by
  whether the row names a resource, or a content state). Beside it: `absenceObservations`,
  `matchesAbsenceCause`, and the types `AbsenceRows`, `AbsenceObservation` and `AbsenceSignature`.
