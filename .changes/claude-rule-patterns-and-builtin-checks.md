### Breaking

- **`@vibe-agent-toolkit/utils`: `toForwardSlash` converts `\` only on Windows**, where it is the
  separator; on POSIX `a\b` is one filename and is returned unchanged. Use the new
  `toForwardSlashAnyPlatform` for authored text (hrefs, globs, config values, zip entries).

### Added

- **`vat resources check` runs built-in checks with no `resources.checks` declared.** The first is
  `claude-rule-glob-inert` (`CLAUDE_RULE_GLOB_INERT`, `info`): a `.claude/rules/` `paths:` glob that
  matches no file. Globs are matched as Claude Code does — drop a leading `./`, which never matches.

- **`claude_rule_patterns`** joins the projection for `vat resources query` and `check` — one row
  per `paths:` glob; `status` is `matched`, `inert`, `unevaluated` or `gitignored` (the glob covers
  only ignored files, which Claude Code still reads). Filter on `status = 'inert'`, never `!= 'matched'`.

- **A launch-cost sum over `claude_context_loads` must count only `launchCharge = 'charged'`**, and
  count `'unknown-size'` rows beside it (they have no `bytes`).

- **`vat resources query` and `vat resources check` publish the stated bounds of the
  `claude_context_*` relations** — `boundsStatement` and a signed `limits` list, once per report.

- **Closure declarations take `traverseGlobs`**, the targets a skill extent follows links through;
  anything else is a leaf, so `vat resources query` reports the skill membership `vat build` ships.

### Fixed

- **A POSIX filename containing a backslash is no longer split into a phantom path.** `docs/x\y.md`
  is one file on macOS and Linux; VAT recorded it as `docs/x/y.md` plus a phantom `docs/x`.

- **`safePath.joinUnderRoot` no longer lets a backslash-spelled `..` escape the root on POSIX.**

### Security

- **`adm-zip` → `0.6.1`** — GHSA-7q85-xj36-vmfc (memory exhaustion from a zip's declared size) and
  GHSA-vwc7-r8mq-g2x9 (symlink-following extraction). Nothing to change.
