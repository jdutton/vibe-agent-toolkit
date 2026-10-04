### Breaking

- **`vat rag stats`, `vat rag query` and `vat rag clear` refuse a database that is not there**, exit
  2, and no longer create it: `USAGE_INVALID` for a `--db` that names nothing (or names a file),
  `INPUT_UNREADABLE` when the project has no database yet or the directory cannot be read (was:
  `stats` reported zeros and `clear` reported `cleared: true`, exit 0). Run `vat rag index` first.
- **`vat rag stats`, `query` and `clear` refuse a directory that is not a RAG database**,
  `USAGE_INVALID`, exit 2, naming what it holds, and remove nothing: a database is a directory
  holding only the tables `vat rag index` writes (or nothing). `vat rag clear --db <any directory>`
  used to delete it recursively and report `cleared: true` (`vat rag clear --db ..` from `docs/`
  deleted the project); `stats` reported zeros for `$HOME`. A project whose `.rag-db` is a file is
  `INPUT_UNREADABLE` saying so (was "nothing indexed yet"). Library: `LanceDBRAGProvider.clear()`
  throws instead of removing such a directory; `@vibe-agent-toolkit/rag-lancedb` exports
  `removeRagDatabase` and `foreignDatabaseEntries`.
- **`vat claude plugin uninstall` refuses a plugin key whose plugin or marketplace name is not one
  path segment** (`/`, `\`, `.`, `..`, absolute or drive-letter), `USAGE_INVALID`, exit 2:
  `'../../../../../victim@x'` used to resolve outside the Claude config dir and delete that
  directory as an "orphan", exit 0. `installPlugin` refuses a plugin name, marketplace name or
  version (the package's own) that is not one segment, coded `PLUGIN_KEY_INVALID`, before writing
  anything; `parsePluginKey` no longer accepts `@scope/name@marketplace`.
- **`installPlugin` returns `{ warnings }`** (was `void`): cleanup that failed after the install
  completed. `vat claude plugin install` logs them.
- **Every `vat` verb refuses a positional argument it does not declare**, exit 2 (`too many
  arguments`); it was silently discarded and the run reported success (`vat audit a b` audited
  only `a`). Drop the extra argument, or run the verb once per path.
- **`vat skills package` no longer deletes what is already at `--output`.** It used to `rm -rf`
  whatever `-o` named — a directory's unrelated contents, or a file — and exit 0. An `--output` that
  already holds anything (a non-empty directory, a file, or the `<output>.zip` /
  `<name>.marketplace.json` a requested format writes beside it) is now refused, `USAGE_INVALID`,
  exit 2, and left exactly as it was; an empty directory is used as-is. Pass the new `--force` to
  replace a previous package. Library: `packageSkill` refuses an occupied explicit `outputPath`
  with a `VatError` coded `SKILL_PACKAGING_OUTPUT_OCCUPIED` unless `replaceExistingOutput: true`
  (the default `dist/skills/<name>` location, and every lane converting through
  `packagingConfigToPackageOptions`, still replace their own previous build).
- **`vat skill test run` no longer changes the mode of an existing `--out`.** It re-moded any
  `--out` to `0700` — which ADDED owner write to a read-only directory, so a run wrote where its
  owner had forbidden it and exited 0. An existing `--out` that is not a `0700` directory is now
  refused, `USAGE_INVALID`, exit 2, naming the fix (`chmod 700` it, or name one that does not exist
  yet; VAT creates a new one `0700`). A harness root the OS will not let the run create is
  `RUN_INCOMPLETE`, exit 2 (was an uncoded failure).
- **`vat resources query` and `vat resources check` refuse SQL whose result has two columns of the
  same name**, `USAGE_INVALID`, exit 2 (was: silently returned one of the two values). A statement
  that builds an over-length value (`SQLITE_TOOBIG`) moved from `INTERNAL_ERROR` to `USAGE_INVALID`.

### Changed

- **A skill build whose output cannot be written ends `RUN_INCOMPLETE`, exit 2** — a full disk, a
  read-only or unwritable output directory, a file in the way of the output path, a previous output
  it cannot remove — in `vat skills build`, `vat skills package`, `vat build`,
  `vat claude plugin build`, `vat agent build` and `vat skill test run`. It is never a
  `SKILL_PACKAGING_FAILED` finding (that is reserved for the skill's own content) and never
  `INTERNAL_ERROR`: `vat agent build`'s own writes, `vat claude plugin build`'s marketplace-tree
  writes and removal, and `vat skills package`'s output removal were uncoded, and a file in the way
  of `vat skills package --output` was published as a `SKILL_PACKAGING_FAILED` finding at the skill,
  exit 1. `vat claude plugin build` still copies plugin trees and `files:` entries uncoded: a disk
  that fills mid-copy there remains `INTERNAL_ERROR`.
- **A ZIP `vat skills package` cannot write is `RUN_INCOMPLETE`, exit 2** (was reported as written,
  `ZIP: <name>` and exit 0, with no archive on disk).
- **One file the OS will not read, anywhere in a git repository, is `INPUT_UNREADABLE` naming that
  file** in `vat skills build`, `vat skills validate`, `vat resources validate`,
  `vat claude context` and the other verbs that crawl through the git snapshot (and so in a
  `vat validate` / `vat build` phase) — was `INTERNAL_ERROR`, "it is not a git repository", about a
  directory that is one. The snapshot reads every file git does not ignore: fix the permissions, or
  ignore the path. `@vibe-agent-toolkit/utils/git` exports `unreadableSnapshotRefusal` and
  `GIT_SNAPSHOT_UNREADABLE_CODE`.
- **A bundled markdown file the pre-build validation cannot read is a `LINK_TARGET_UNREADABLE`
  error finding at that file** (exit 1) in every lane that validates a skill for packaging — was an
  uncoded `INTERNAL_ERROR` outside git, while the same unreadable file with a non-markdown extension
  was already the skill's finding.
- **`vat skills build` promotes `dist/skills` with the ordinary directory mode** (was `0700`, from
  its temporary staging root, unreadable to group and other), and a refusal after discovery reports
  the skills it found in `examined` (was `0`).
- **`files:` `integrity: true` codes each read by the tree it touched**: a dest the OS will not read
  is the output's (`RUN_INCOMPLETE`), a source the skill's (`SKILL_PACKAGING_FAILED`); a dest-set
  listing it cannot read was uncoded.
- **`installPlugin` (`@vibe-agent-toolkit/claude-marketplace`, library-only) refuses a `pluginDir`
  any file of which it cannot read** — anywhere in the tree, not only its top level — with a
  `VatError` coded `PLUGIN_SOURCE_UNREADABLE` naming that file, before creating anything (a nested
  one was `CLAUDE_USER_STATE_WRITE_FAILED` naming the `~/.claude` destination).
- **A failed plugin re-install keeps the previous plugin cache** (`installPlugin`, and so
  `vat claude plugin install`): the new copy is staged beside it and swapped in only once whole,
  where the cache the registry points at used to be deleted first. A previous tree the OS will not
  let it remove once replaced no longer fails the install — the registry and settings are still
  written, and the leftover is reported as a warning. Staged and parked trees are dot-named, and
  `vat inventory --user` no longer reads a dot-named directory under a plugin's cache as an
  installed version. The cached version directory takes the plugin's own mode (it was `0700`), and
  a dangling link at its path is replaced instead of failing the install.
- **A RAG database whose table files are damaged is `INPUT_UNREADABLE`** in `vat rag stats` and
  `vat rag query` (was `INTERNAL_ERROR`), and **`vat rag clear` removes it**: `clear` no longer
  opens the database it removes, so the documented remedy works. `LanceDBRAGProvider` throws a
  `VatError` coded `RAG_DATABASE_UNREADABLE` (`RAG_DATABASE_UNREADABLE_CODE`, from
  `@vibe-agent-toolkit/utils`).
- **`vat corpus scan` declares `[seed-file]` once**: it registered it twice, so a second operand
  was silently ignored, exit 0, and `--help` printed `[seed-file] [seed-file]`.
