### Breaking

- **`@vibe-agent-toolkit/resources`: `CrawlSource` requires `symlinks`** — every symbolic link the
  last `enumerate()` declined. A custom source must report its declined links, or return `[]` when it
  follows none.
- **`BuiltinCheck` requires `code`** (the registry code its findings carry), and
  **`BuiltinCheckInput` requires `resourceTags`, `blobs` and `contentKey` on each realization.** A
  `Projection` still satisfies the input unchanged.

### Added

- **`vat resources check` reports a `.claude/rules/` file whose YAML frontmatter does not parse**
  or parses to a list or a scalar — built-in `claude-rule-frontmatter-invalid`,
  `CLAUDE_RULE_FRONTMATTER_INVALID` at `warning`. Quote any `paths:` glob starting with `*`.

- **A symlinked file is no longer silently absent from `vat resources query`.** VAT still realizes no
  link path, so it counts in no size, chain or rule-pattern row; each declined link is a
  `realization_conditions` row under one of three `info` codes — `EXTENT_SYMLINK_NOT_REALIZED`,
  `EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT` or `EXTENT_SYMLINK_TARGET_UNRESOLVED`. A SQL query about
  declined links must ask for all three; silence each with `resources.validation.severity.<code>: ignore`.

- **`@vibe-agent-toolkit/utils`: `crawlDirectory` takes `onSymlinkNotFollowed`**, called once per
  link the walk declines. Walk route only: it requires `respectGitignore: false` and throws
  otherwise, because the `git ls-files` route declines no link.

### Fixed

- **`vat resources check --help`'s "copy this into `resources.checks`" block is valid YAML.** A
  built-in's description contains `paths: `, and written unquoted it parsed as a nested map. The
  help's list of built-ins, their codes and default severities is now rendered from the registry.
