### Breaking

- **`@vibe-agent-toolkit/resources` no longer exports `PackageExtentContributor`,
  `PackageExtentParametersSchema`, `PackageExtentParameters` or the `PACKAGE_*` absence codes.**
  No command ever used that contributor; remove any import of them.
