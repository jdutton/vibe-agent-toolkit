### Added

- **`vat resources check` now runs built-in checks with no `resources.checks` declared.** The first
  is `claude-rule-glob-inert`, emitting `CLAUDE_RULE_GLOB_INERT` at `info` for every `paths:` glob
  under `.claude/rules/` that matches no file. Silence it with
  `resources.validation.severity.CLAUDE_RULE_GLOB_INERT: ignore`; run it alone with
  `--check claude-rule-glob-inert`. Built-ins are never SQL, and `data.checks` marks them
  `builtin: true`.

- **`claude_rule_patterns`** joins the projection for `vat resources query` and `check` — one row
  per `paths:` glob with `pattern`, `literalPrefix`, `witnessPath` and `status`
  (`matched` | `inert` | `unevaluated` | `gitignored`). ⚠️ Filter on `status = 'inert'`, never
  `status != 'matched'`: `unevaluated` means VAT never ran the matcher.

- **A `paths:` glob that covers gitignored files is `gitignored`, not `inert`**, and
  `CLAUDE_RULE_GLOB_INERT` no longer reports it. VAT never reads ignored files, but Claude Code
  does, so a rule scoped to `dist/**` may still load. The result is the same whether or not
  `dist/` is built. A glob with no literal prefix (`**/*.gen.ts`) is still judged `inert`.

- **A launch-cost sum over `claude_context_loads` must count only `launchCharge = 'charged'`**, and
  count `'unknown-size'` rows beside it (they have no `bytes`). `sizeCliff` is the 4 MiB `CLAUDE.md`
  cliff's verdict, not the launch charge.

- **`vat resources query` and `vat resources check` publish the stated bounds of the
  `claude_context_*` relations** — `boundsStatement` and a signed `limits` list, once per report,
  whenever the claude-context lens was evaluated. The lane a project can make gate is the lane whose
  caveats it most needs; `vat claude context` already published them beside its own answer.

- **Closure declarations take `traverseGlobs`**, the targets a skill extent follows links through;
  anything else is a leaf. The build lanes declare `**/*.md`, so `vat resources query` reports the
  same skill membership `vat build` ships, assets included.

### Removed

- **`vat claude budget` is gone, with the always-loaded context threshold, the
  `ALWAYS_LOADED_CONTEXT_BUDGET` code and `resources.validation.thresholds`.** VAT publishes what
  Claude Code loads at launch — `claude_context_chains` / `claude_context_loads`, and
  `vat claude context` — and ships no verdict on it. A built-in byte limit invites byte-shaving
  without the guidance that makes trimming a `CLAUDE.md` worthwhile, so what a launch chain may cost
  is the project's own call: write it as a `resources.checks` statement summing
  `WHERE launchCharge = 'charged'`. Never shipped in a stable release.

### Changed

- **A statement over a derived relation the run did not evaluate fails with `no such table`**, plus
  a note that no declared statement named it. `vat resources check` reports it as
  `RESOURCE_CHECK_BROKEN` instead of reading an empty table and passing.

### Fixed

- **A POSIX filename containing a backslash is no longer split into a phantom path.** On macOS and
  Linux `docs/x\y.md` is one file; VAT recorded it as `docs/x/y.md` (unreadable) plus a phantom
  `docs/x` directory, and a rules file `.claude/rules/a\b.md` dropped out of `claude_rule_patterns`.
  `toForwardSlash` (and every `safePath` helper) now converts only where `\` is the separator
  (Windows); the new `toForwardSlashAnyPlatform` converts authored text (hrefs, globs, config
  values, zip entries) on every host. `local/no-manual-path-normalize` now also flags hand-rolled
  `replaceAll('\\', '/')` and autofixes a literal-backslash conversion to the new function.

- **`safePath.joinUnderRoot` no longer lets a backslash-spelled `..` escape the root on POSIX.**
  `x\..\..\secret` is one filename there and now stays under the root; it was converted to a climb
  after the containment check had passed.

- **`adm-zip` → `0.6.1`.** Fixes GHSA-7q85-xj36-vmfc (CVSS 7.5, memory exhaustion from a zip's
  declared size) and the symlink-following extraction advisory GHSA-vwc7-r8mq-g2x9, whose
  accepted-risk entry is removed. Nothing to change.
