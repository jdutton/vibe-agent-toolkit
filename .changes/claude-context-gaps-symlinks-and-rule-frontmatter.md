### Added

- **`vat resources check` reports a `.claude/rules/` file whose YAML frontmatter does not parse**
  or parses to a list or a scalar — built-in `claude-rule-frontmatter-invalid`,
  `CLAUDE_RULE_FRONTMATTER_INVALID` at `warning`. Quote any `paths:` glob starting with `*`.

- **Every symbolic link VAT declines is a `realization_conditions` row** under one of three `info`
  codes — `EXTENT_SYMLINK_NOT_REALIZED`, `_TARGET_OUTSIDE_ROOT` or `_TARGET_UNRESOLVED`. A linked
  file counts in no size, chain or rule-pattern row; a SQL query about declined links must ask for
  all three codes.

- **`@vibe-agent-toolkit/utils`: `crawlDirectory` takes `onSymlinkNotFollowed`**, called once per
  link the walk declines. It requires `respectGitignore: false` and throws otherwise.
