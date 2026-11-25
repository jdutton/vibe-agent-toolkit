### Breaking

- **`@vibe-agent-toolkit/resources` no longer exports `PackageExtentContributor`,
  `PackageExtentParametersSchema`, `PackageExtentParameters` or the `PACKAGE_*` absence codes.**
  No command ever used that contributor; remove any import of them.
- **`@vibe-agent-toolkit/utils/testing`: `AbsenceSignature` and `AbsenceObservation` no longer
  carry `resourceIdPresent`, and `AbsenceRows.realizationConditions` no longer needs `resourceId`.**
  Drop the field from any signature you pass to `expectAbsenceCause`.

### Added

- **`@vibe-agent-toolkit/resources` exports `MARKDOWN_BY_CONTRACT`**, the parser kind of a document
  a contract makes markdown (a `SKILL.md`, a frontmatter block). It is the string `'markdown'`; no
  file is parsed differently.
