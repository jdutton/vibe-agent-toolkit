### Breaking

- **Every human finding line is now `location:line: severity: message [CODE]`**, the same line
  `--format text` prints, in place of `[SEVERITY] [CODE] message` plus a `Location:` line. A log
  filter matching the old `[ERROR]` prefix must match `: error: ` instead. A finding with a fix
  prints it on the next line, indented two more spaces, as `Fix: …`. This covers the lanes that
  printed a finding their own way: `vat ard emit`'s text-mode stderr (the bare message before),
  `vat claude org skills install`'s portability warnings (`location: message`), `vat rag index`'s
  unreadable resources (`[vat-rag] message`) and documents the index provider failed (the
  provider's own `[vat-rag] Failed to index resource …` line, which `@vibe-agent-toolkit/rag-lancedb`
  no longer prints: read `IndexResult.errors`), `vat claude plugin install`'s and `vat skills install`'s
  leftovers (the bare message), a refusal's leftovers (`warning: message`) and `vat audit`'s
  capability-evidence headings (`[CODE] message`).
- **The run-integrity refusal (`RESOURCE_CHECK_BROKEN`, "Nothing was examined: …") is a finding line
  on stderr too**, `error: Nothing was examined: … [RESOURCE_CHECK_BROKEN]`, printed once. It was
  `Warning: Nothing was examined: …`, which read as a warning for a run that fails, and a refusal a
  lane had already reported could print twice. Affects `vat validate`, `vat verify`,
  `vat resources validate` and `vat claude marketplace validate`.
- **`--format text` lines now carry a finding's `field`**, as stderr does: `SKILL.md (frontmatter.name):
  error: …`, and `(frontmatter.name): error: …` for a finding with a field and no file, which printed
  with no anchor before. A parser splitting a text line on its first `: ` must allow for the
  parenthesised field.

### Changed

- **`vat validate`, `vat verify` and `vat resources validate` now print resources and checks findings
  on stderr**, as their help always said: every error, errors first, plus warnings and info with
  `--verbose`. The stdout document is unchanged; read stderr and redirect stdout to a file.
  Under `vat resources validate --format text` stdout already is these lines, so stderr carries none.
- **`vat resources check` reports its findings on stderr the same way**, and gains `-v, --verbose`
  to include the warning and info ones.
- **The collapsed-findings hint says "read the report on stdout"**, not "this audit's YAML report":
  the same verb publishes JSON under `--format json`.
- **`vat claude marketplace validate`'s `N error(s), N warning(s), N info` line counts the published
  document**, so a run refused for examining nothing prints `1 error(s)`, not `0 error(s)` beside exit 1.
  Inside `vat verify` the marketplace phase no longer prints that line.
- **`vat verify` prints the `packaged-content` banner before that phase's zero-bundle refusal**, which
  printed under the previous phase's banner.
