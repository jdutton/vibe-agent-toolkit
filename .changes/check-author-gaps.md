### Added

- **`sha256(x)` in `vat resources query` and `vat resources check` SQL.** It returns the lowercase
  hex SHA-256 of a TEXT value's UTF-8 bytes or a BLOB's bytes, and NULL for NULL. A number is
  refused: `CAST(x AS TEXT)` first, since SQLite and JavaScript spell `1.0` differently.
- **`regexp(pattern, text[, flags])` and the `text REGEXP pattern` operator in the same SQL.** The
  pattern is a JavaScript RegExp, always under the `u` flag; `flags` may add `i`, `m` and `s`. A
  backtracking pattern is bounded only by the run's budget.
- **`DATA_INCLUDE_GLOB_INERT` (warning)** names each `resources.extractors.data.include` glob that
  matches no `.json` or `.jsonc` file, in `vat resources check` and the `checks` phase of
  `vat validate`. `vat resources query` writes the same message to stderr when its statement names
  a `data__*` relation.

### Changed

- **An `include` glob that matches nothing no longer refuses every `data__*` statement.** It was
  `CONFIG_INVALID`; now the other routed files answer and the glob is the `DATA_INCLUDE_GLOB_INERT`
  warning. A declared `resources.extractors.data` block that routes no file at all still refuses.
  `allowEmpty: true` excuses both, as before, and `resources.validation.severity` can silence the
  warning.
- **Docs: a `data__values` read of a path no route covers selects zero rows, which is a check's
  pass.** `packages/cli/docs/resources.md` shows the `examined:` count over `data__routes` that makes
  such a check fail as `RESOURCE_CHECK_EXAMINED_NOTHING` instead, and warns that `data__routes.blob`
  is a content key, not a digest: a tracked file's key is its git object ID.
- **Docs: a CTE that later terms read more than once, or from a correlated subquery, can be re-run
  per row.** `packages/cli/docs/resources.md` shows the `AS MATERIALIZED` form; an adopter's check
  went from 1.25 s to 0.024 s with it.
- **Reading a git member's size and bytes now goes through one long-lived `git cat-file
  --batch-command` per repository** (git 2.36 and later; older git uses a long-lived `--batch-check`
  and `--batch` pair), and a member is sized only when it is asked about. Before, the first size
  request sized every file in the tree, so one edited file cost a batch check over the whole
  repository.
