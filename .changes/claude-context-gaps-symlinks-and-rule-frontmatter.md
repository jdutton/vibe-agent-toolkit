### Breaking

- **`@vibe-agent-toolkit/resources`: `CrawlSource` requires `symlinks`** — every symbolic link the
  last `enumerate()` declined. A custom source must report its declined links, or return `[]` when it
  follows none.
- **`BuiltinCheck` requires `code`** (the registry code its findings carry), and
  **`BuiltinCheckInput` requires `resourceTags`, `blobs` and `contentKey` on each realization.** A
  `Projection` still satisfies the input unchanged.

### Added

- **`vat resources check` reports a `.claude/rules/` file whose YAML frontmatter does not parse**
  — built-in `claude-rule-frontmatter-invalid`, code `CLAUDE_RULE_FRONTMATTER_INVALID` at `warning`.
  Such a rule used to pass `claude-rule-glob-inert` silently; quote any `paths:` glob starting with `*`.
  `vat resources validate` already reports the same file as `FRONTMATTER_INVALID_YAML` (`error`).

- **A symlinked file is no longer silently absent from `vat resources query`.** VAT still realizes no
  link path, so a symlinked `CLAUDE.md` or rules file counts in no size, chain or rule-pattern row;
  each link is now a `realization_conditions` row `EXTENT_SYMLINK_NOT_REALIZED` (`info`) naming an
  in-root target and whether it is realized; an out-of-root target (including a Windows `C:/…` or
  UNC target read on another OS) is described, never named. The common `CLAUDE.md -> AGENTS.md` now
  shows up as an `info` finding wherever the registry reports (`vat resources validate`, `vat skills
  validate`, `vat skills build`, `vat claude plugin build`) when the crawl's `include`/`exclude`
  would admit the link's path, and in a `vat claude context <dir>` answer when the link is beneath
  `<dir>`, a `CLAUDE.md`-family link on its chain, or under a `.claude` directory on its chain. Set
  `resources.validation.severity.EXTENT_SYMLINK_NOT_REALIZED: ignore` to silence it in
  `vat resources validate`.

- **`@vibe-agent-toolkit/utils`: `crawlDirectory` takes `onSymlinkNotFollowed`**, called once per
  link the walk declines. Walk route only: it requires `respectGitignore: false` and throws
  otherwise, because the `git ls-files` route declines no link.

### Fixed

- **`vat resources check --help`'s "copy this into `resources.checks`" block is valid YAML.** A
  built-in's description contains `paths: `, and written unquoted it parsed as a nested map. The
  help's list of built-ins, their codes and default severities is now rendered from the registry.
