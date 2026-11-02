### Breaking

- **Every human finding line is now `location:line: severity: message [CODE]`**, the same line
  `--format text` prints, in place of `[SEVERITY] [CODE] message` plus a `Location:` line. A log
  filter matching the old `[ERROR]` prefix must match `: error: ` instead. A finding with a fix
  prints it on the next line, indented two more spaces, as `Fix: …`. This covers the lanes that
  printed a finding their own way: `vat ard emit`'s text-mode stderr (the bare message before),
  `vat claude org skills install`'s portability warnings (`location: message`), `vat agent validate`'s
  findings (`- [severity] message [CODE]`), `vat verify`'s consistency phase (`ERROR [CODE]: message`,
  `WARN …`, `INFO …`, each with a `Fix:` line) and its files-config-dests phase (one
  `FILES_CONFIG_DEST_MISSING` line per missing destination, in place of a `Skill '<name>': missing
  dest file(s)` heading over a bulleted list), `vat rag index`'s
  unreadable resources (`[vat-rag] message`) and documents the index provider failed (the
  provider's own `[vat-rag] Failed to index resource …` line, which `@vibe-agent-toolkit/rag-lancedb`
  no longer prints: read `IndexResult.errors`), `vat claude plugin install`'s and `vat skills install`'s
  leftovers (a finding line with no `Fix:` before), a refusal's leftovers (`warning: message`),
  `vat claude plugin uninstall`'s failures (`⚠️ message`), `vat skills build --skill`'s refusal of a
  `publish: false` skill (the bare message) and `vat audit`'s capability-evidence headings
  (`[CODE] message`).
- **The run-integrity refusal (`RESOURCE_CHECK_BROKEN`, "Nothing was examined: …") is a finding line
  on stderr too**, `error: Nothing was examined: … [RESOURCE_CHECK_BROKEN]`, printed once. It was
  `Warning: Nothing was examined: …`, which read as a warning for a run that fails, and a refusal a
  lane had already reported could print twice. Affects `vat validate`, `vat verify`, `vat build`,
  `vat resources validate` and `vat claude marketplace validate`; the document writer now prints it
  for every report verb, so `vat rag index`, `vat skills build` and the others that said nothing on
  stderr now say it. `vat skills validate` printed only the globs that matched nothing; it now prints
  this refusal too, whose remedy points at that globs line. Under `--format text` stdout already
  carries the line, so stderr does not repeat it.
- **`vat audit settings` no longer prints its count lines** (`N warning(s): see findings …`,
  `N settings path(s) could not be checked.`, `Legacy managed-settings.json path detected …`): each
  finding prints on stderr instead. A log filter matching those lines must match the finding's
  `[CODE]`.
- **`@vibe-agent-toolkit/rag-lancedb` no longer prints its chunking-config warnings** (`[vat-rag] …`
  on the console). They are in `IndexResult.warnings`; `vat rag index` reports each as a
  `RAG_CHUNKING_CONFIG_ADJUSTED` warning finding, which does not change the exit code.
- **`--format text` lines now carry a finding's `field`**, as stderr does: `SKILL.md (frontmatter.name):
  error: …`, and `(frontmatter.name): error: …` for a finding with a field and no file, which printed
  with no anchor before. A parser splitting a text line on its first `: ` must allow for the
  parenthesised field.

### Added

- **`@vibe-agent-toolkit/rag`: `IndexResult.warnings`** (optional `string[]`), what the provider adjusted
  about its own configuration; and **`IndexBatchRefusedError` / `partialIndexResultOf(error)`**: a batch
  the store refuses partway (`RAG_DATABASE_UNREADABLE`) is thrown under that code carrying the
  `IndexResult` it had recorded so far (library-only).

### Changed

- **`vat validate`, `vat verify` and `vat resources validate` now print resources and checks findings
  on stderr**, as their help always said: every error, errors first, plus warnings and info with
  `--verbose`. The stdout document is unchanged; read stderr and redirect stdout to a file.
  Under `vat resources validate --format text` stdout already is these lines, so stderr carries none.
- **`vat okf validate` and `vat audit settings` print each finding on stderr**, in place of nothing
  (`okf validate`) or a count line (`audit settings`, under Breaking). A refused `vat okf validate`
  prints the findings of every bundle it did read, as any refusal now prints the work that finished.
- **`vat ard emit` prints its findings on stderr under `--format json` too**, not only under text.
  `vat claude plugin uninstall` now prints `PLUGIN_KEPT_SIBLING_UNEXAMINED`, which it never printed,
  and `vat audit <git-url>` prints a clone it could not remove.
- **A refusal's leftovers are not printed twice under `vat resources validate --format text`**:
  stdout already lists them.
- **`vat resources check` reports its findings on stderr the same way**, and gains `-v, --verbose`
  to include the warning and info ones.
- **The collapsed-findings hint says "read the report on stdout"**, not "this audit's YAML report":
  the same verb publishes JSON under `--format json`.
- **`vat claude marketplace validate`'s `N error(s), N warning(s), N info` line counts the published
  document**, so a run refused for examining nothing prints `1 error(s)`, not `0 error(s)` beside exit 1,
  and a run that could not do its job (exit 2) prints no count line at all. Inside `vat verify` the
  marketplace phase no longer prints that line.
- **`vat rag index` names every file it could not read even when the database then refuses the run**:
  each is a `RAG_DOCUMENT_INDEX_FAILED` finding in the refusal document and a line on stderr. Documents the provider failed
  before the database refused the batch, and its chunking warnings, are reported the same way.
- **`vat verify` prints the `packaged-content` banner before that phase's zero-bundle refusal**, which
  printed under the previous phase's banner.
