### Added

- **`EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT`** (`info`): a declined symlink whose target resolves
  outside the project root now carries its own `realization_conditions` code. A SQL query about
  declined links must ask for both (`code IN ('EXTENT_SYMLINK_NOT_REALIZED',
  'EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT')`).

- **`vat resources check` reports a `.claude/rules/` file or directory that is a symlink** —
  built-in `claude-rule-link-unchecked`, code `CLAUDE_RULE_LINK_UNCHECKED` at `warning`. VAT cannot
  read a rule it reaches only through a link, so its globs and frontmatter go unchecked.
  Set `resources.validation.severity.CLAUDE_RULE_LINK_UNCHECKED: ignore` to accept the blind spot.

### Changed

- **`CLAUDE_RULE_LINK_UNCHECKED` says which arm it found.** An in-root link's rule is in force and
  unchecked — replace the link with the file. An out-of-root link's rule is in force nowhere,
  because Claude Code skips it — vendor those rules into the repository.

- **A rules file's `paths:` is now read the way Claude Code reads it**, which moves the
  always-loaded total `vat claude context` reports. A string is a pattern list (`paths: src/**`, and
  `"a/**, b/**"` is two patterns); a `paths:` that normalises to nothing or to `**` alone makes the
  rule always-loaded, not path-scoped.

### Fixed

- **`CLAUDE_RULE_GLOB_INERT` matches `paths:` globs the way Claude Code does (gitignore rules)**, so
  it no longer calls a live glob dead. A glob starting `./` never matches in Claude Code and is now
  reported — drop the `./`.

- **A rules file whose frontmatter is valid YAML but not a mapping is reported** instead of reading
  as "no frontmatter", which made the rule look unconditional.

- **A symlink whose target differs from the realized file only in case or Unicode form is no longer
  called unrealized** on a filesystem that opens it.
