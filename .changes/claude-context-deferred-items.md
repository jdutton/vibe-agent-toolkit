### Added

- **`EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT` and `EXTENT_SYMLINK_TARGET_UNRESOLVED`** (`info`): a
  declined symlink that resolves outside the project root, or to nothing, carries its own
  `realization_conditions` code. A SQL query about declined links must ask for all three codes.

- **`vat resources check` reports a `.claude/rules/` file or directory that is a symlink** —
  built-in `claude-rule-link-unchecked`, `CLAUDE_RULE_LINK_UNCHECKED` at `warning`. For an
  out-of-root target Claude Code skips the rule too, so vendor those rules into the repository.
  Set `resources.validation.severity.CLAUDE_RULE_LINK_UNCHECKED: ignore` to accept the blind spot.

- **`paths:` globs are read and matched the way Claude Code does it.** A string `paths:` is a
  comma-separated pattern list; an empty or `**`-only `paths:` makes the rule always-loaded. A glob
  starting `./` never matches in Claude Code and is reported by `CLAUDE_RULE_GLOB_INERT` — drop the `./`.

- **`CLAUDE_RULE_FRONTMATTER_INVALID` also reports frontmatter that parses to a list or a scalar**
  rather than a mapping; such a rule has no `paths:` at all.
