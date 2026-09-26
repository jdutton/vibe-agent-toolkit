### Added

- **`vat resources check` reports a `.claude/rules/` file or directory that is a symlink** —
  built-in `claude-rule-link-unchecked`, `CLAUDE_RULE_LINK_UNCHECKED` at `warning`. Claude Code skips
  a rule whose link resolves outside the directory the session started in, so vendor those rules.
