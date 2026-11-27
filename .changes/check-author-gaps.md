### Added

- **`sha256(x)` in `vat resources query` and `vat resources check` SQL.** It returns the lowercase
  hex SHA-256 of a TEXT value's UTF-8 bytes or a BLOB's bytes, and NULL for NULL or a number:
  hash `CAST(x AS TEXT)` for a number's spelling, since SQLite and JavaScript spell `1.0`
  differently.
- **`regexp(pattern, text[, flags])` and the `text REGEXP pattern` operator in the same SQL.** The
  pattern is a JavaScript RegExp, always under the `u` flag; `flags` may add `i`, `m` and `s`,
  each once. A malformed pattern is refused even over a column of NULLs. A backtracking pattern is
  bounded only by the run's budget, so `vat resources query` without `--budget` has no bound.
- **`DATA_INCLUDE_GLOB_INERT` (warning)** names each `resources.extractors.data.include` glob that
  matches no `.json`, `.jsonc`, `.yaml` or `.yml` file, in `vat resources check` and the `checks` phase of
  `vat validate`. `vat resources query` writes the same finding, with its code, to stderr when its
  statement names a `data__*` relation; `resources.validation.severity` silences it in both.

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
- **Docs: a CTE read from a correlated subquery can be inlined and re-run for every outer row.**
  `packages/cli/docs/resources.md` shows the `AS MATERIALIZED` form; an adopter's check went from
  1.25 s to 0.024 s with it.
- **Reading a git member's size and bytes now goes through one long-lived `git cat-file
  --batch-command` per repository** (git 2.36 and later; older git uses a long-lived `--batch-check`
  and `--batch` pair), and a member is sized only when it is asked about. Before, the first size
  request started a one-shot `--batch-check` over every file in the tree. An edit that misses the
  stored extent still sizes every member the recompute keys (keying a member sizes it against the
  input cap), now over the one long-lived child, so the trim on that path is one spawn, not fewer
  objects.
