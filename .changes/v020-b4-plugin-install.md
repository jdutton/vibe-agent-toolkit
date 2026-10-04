### Breaking

- **`vat claude plugin install <dir>` refuses a plain directory with no `SKILL.md`**, `USAGE_INVALID`,
  exit 2, installing nothing. A directory with no plugin tree, no `package.json` and no `SKILL.md`
  used to be copied whole into `~/.claude/skills/` and reported installed.
- **`vat claude plugin uninstall <key> --all` is refused**, `USAGE_INVALID`, exit 2, removing nothing:
  `--all` ignored the key, uninstalled the plugins of the package in the current directory, and
  exited 0 with the named plugin still installed.

### Fixed

- **`vat claude plugin install <file>.zip` over a file that is not a ZIP archive is
  `INPUT_UNREADABLE`**, exit 2, naming the file (was `INTERNAL_ERROR`). The archive is opened before
  anything is replaced, so `--force` no longer removes the existing skill first.
- **A plugin re-install replaces its marketplace copy** (`~/.claude/plugins/marketplaces/<mp>/plugins/<name>`)
  the way it already replaced the cache copy: a file the plugin dropped no longer survives there. A
  previous marketplace tree the install could not remove is reported like a cache one
  (`PLUGIN_INSTALL_CLEANUP_INCOMPLETE`).
- **A `--dry-run` uninstall of a plugin directory no registry recorded** says the directory would
  be removed, not that it is "cleaning up".
