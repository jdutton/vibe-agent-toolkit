### Fixed

- **`vat agent install`, `uninstall` and `installed` resolve their scopes when they run, through the
  same Claude-user-paths resolver every other verb uses.** The `user` scope now honours
  `CLAUDE_CONFIG_DIR` (it read `~/.claude/skills` regardless), and the `project` scope honours
  `--cwd` (it was fixed to the launch directory, so `vat --cwd ../proj agent uninstall x --scope
  project` removed from the wrong tree). A skill installed to the user scope is now visible to
  `vat skills list --user`.
- **`vat audit settings` reads the user settings layer from `$CLAUDE_CONFIG_DIR/settings.json`**
  when the variable is set, the same file `--show-paths` names. It read `~/.claude/settings.json`
  regardless, so a relocated config was audited as the wrong file or as nothing readable.
