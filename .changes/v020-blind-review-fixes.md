### Breaking

- **`vat rag stats`, `vat rag query` and `vat rag clear` refuse a database that is not there**, exit
  2, and no longer create it: `USAGE_INVALID` for a `--db` that names nothing (or names a file),
  `INPUT_UNREADABLE` when the project has no database yet or the directory cannot be read (was:
  `stats` reported zeros and `clear` reported `cleared: true`, exit 0). Run `vat rag index` first.
- **`vat rag stats`, `query` and `clear` refuse a directory that is not a RAG database**,
  `USAGE_INVALID`, exit 2, naming what it holds, and remove nothing: a database is a directory
  holding only the tables `vat rag index` writes (or nothing), operating-system litter (`.DS_Store`,
  `Thumbs.db`, `desktop.ini`, `._*`) aside. The project's own `.rag-db` holding anything else is
  `INPUT_UNREADABLE` (no `--db` was given to correct). `vat rag clear --db <any directory>`
  used to delete it recursively and report `cleared: true` (`vat rag clear --db ..` from `docs/`
  deleted the project); `stats` reported zeros for `$HOME`. A project whose `.rag-db` is a file is
  `INPUT_UNREADABLE` saying so (was "nothing indexed yet"). Library: `LanceDBRAGProvider.clear()`
  throws instead of removing such a directory; `@vibe-agent-toolkit/rag-lancedb` exports
  `removeRagDatabase` and `foreignDatabaseEntries`.
- **`vat rag clear` refuses a database path that is a symbolic link**, exit 2, naming the real path
  to clear (`USAGE_INVALID` for `--db`, `INPUT_UNREADABLE` for the project's `.rag-db`): it removed
  only the link and reported `cleared: true` while the index stayed on disk. A clear the OS stops
  partway is `RUN_INCOMPLETE` (was `INTERNAL_ERROR`). `removeRagDatabase` throws `VatError`s coded
  `RAG_DATABASE_NOT_REMOVABLE` (a link, or foreign entries; was an uncoded `Error`) and
  `RAG_DATABASE_REMOVAL_INCOMPLETE` (codes exported from `@vibe-agent-toolkit/utils`).
- **`claude.marketplaces` names must be one path segment** — not empty, `.`, `..`, and no `/`, `\`,
  NUL or drive prefix — or the config is `CONFIG_INVALID`. A marketplace named
  `"../../../../victim"` made `vat claude plugin build` (and `vat build`) delete that directory,
  outside `dist/`, and write the marketplace over it, exit 0.
- **`vat skills package` refuses an `--output` that is, or contains, the skill's own source** — the
  SKILL.md or any file it bundles — `USAGE_INVALID`, exit 2, `--force` or not, and writes nothing.
  It skipped every occupancy check then and overwrote the author's SKILL.md and the files beside it.
  Library: `packageSkill` refuses it coded `SKILL_PACKAGING_OUTPUT_OCCUPIED`; a caller that
  generated the SKILL.md into its output itself (the agent builder) passes the new
  `sourceGeneratedInOutput: true`.
- **`vat claude plugin install` refuses a package whose plugin or marketplace directory, version or
  `vat.replaces.plugins` entry is not one path segment, or whose version begins with `.`**,
  `INPUT_UNREADABLE`, exit 2, before anything under `~/.claude` changes. A hostile version used to
  be refused `USAGE_INVALID` only after the marketplace directory was already replaced, leaving it
  out of step with the registry; a dot-led version installed and was then invisible to
  `vat inventory --user`. `installPlugin` refuses a dot-led version (`PLUGIN_KEY_INVALID`), and
  `@vibe-agent-toolkit/claude-marketplace` exports `requirePluginInstallNames`, the check it runs.
- **`vat claude plugin uninstall --all` refuses a registry key of the package that is not
  `<plugin>@<marketplace>`**, `INPUT_UNREADABLE` (the key came from `installed_plugins.json`, not
  the command line), before removing anything — it was `USAGE_INVALID` mid-loop, after the plugins
  ahead of it were already gone. `findPluginsByPackage` throws `CLAUDE_USER_STATE_UNREADABLE` for it.
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
  exit 2, and left exactly as it was, the message naming `--force`; an empty directory is used
  as-is. Pass the new `--force` to replace a previous package: it removes the `--output` and
  overwrites a `<output>.zip` / `<name>.marketplace.json` FILE beside it, but never removes a
  directory standing where an archive goes (that write ends `RUN_INCOMPLETE`). `--dry-run` runs the
  same check, so a preview no longer reports `ok` for an output the real run refuses. Library:
  `packageSkill` refuses an occupied explicit `outputPath` with a `VatError` coded
  `SKILL_PACKAGING_OUTPUT_OCCUPIED` unless `replaceExistingOutput: true` (the default
  `dist/skills/<name>` location, and every lane converting through
  `packagingConfigToPackageOptions`, still replace their own previous build); the check is exported
  as `checkPackageOutput`.
- **`vat skill test run` no longer changes the mode of an existing `--out`.** It re-moded any
  `--out` to `0700` — which ADDED owner write to a read-only directory, so a run wrote where its
  owner had forbidden it and exited 0. An existing `--out` that is not a directory (a file: was
  `RUN_INCOMPLETE`), or on POSIX is not `0700`, is now refused, `USAGE_INVALID`, exit 2, naming the
  fix (`chmod 700` it, or name one that does not exist yet; VAT creates a new one `0700`). Windows
  has no mode check. A harness root, lockfile, staged skill copy, staged manifest or `results/`
  file the OS will not let the run write (a full disk, a read-only directory) is `RUN_INCOMPLETE`,
  exit 2 (was an uncoded `INTERNAL_ERROR`).
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
  exit 1. Every copy `vat claude plugin build` makes into the marketplace tree — the marketplace
  `LICENSE` / `README.md` / `CHANGELOG.md`, plugin trees, plugin `files[]` entries, pool skills from
  `dist/skills`, a plugin's `CHANGELOG.md` — reads its source first: a source the OS will not read is
  `INPUT_UNREADABLE` naming it (a file in `dist/skills` too — rebuild it), and a write the OS
  refuses is `RUN_INCOMPLETE` (both were `INTERNAL_ERROR`). Known gap: a disk so full that the git
  snapshot of the project fails before anything is written still ends `INTERNAL_ERROR`, "git did
  not answer …", in every verb that crawls through the snapshot.
- **A ZIP, npm `package.json` or marketplace manifest `vat skills package` cannot write is
  `RUN_INCOMPLETE`, exit 2** (the ZIP was reported as written, `ZIP: <name>` and exit 0, with no
  archive on disk; the two manifests were `INTERNAL_ERROR`). A partial file the failed write
  created is removed, so the next run does not refuse it as a previous package, and the refusal
  names the file forward-slashed and relative to the project.
- **One file the OS will not read, anywhere in a git repository, is `INPUT_UNREADABLE` naming that
  file** in `vat skills build`, `vat skills validate`, `vat resources validate`,
  `vat claude context` and the other verbs that crawl through the git snapshot (and so in a
  `vat validate` / `vat build` phase) — was `INTERNAL_ERROR`, "it is not a git repository", about a
  directory that is one. The snapshot reads every file git does not ignore: fix the permissions, or
  ignore the path. `@vibe-agent-toolkit/utils/git` exports `unreadableSnapshotRefusal` and
  `GIT_SNAPSHOT_UNREADABLE_CODE`.
- **A bundled markdown file the pre-build validation cannot read is a `LINK_TARGET_UNREADABLE`
  error finding at that file** (exit 1) in `vat skills build` and `vat skills validate` (and so their
  `vat build` / `vat validate` phases) — was an uncoded `INTERNAL_ERROR` outside git, while the same
  unreadable file with a non-markdown extension was already the skill's finding.
  `vat skills package` runs no such validation: there it is a `SKILL_PACKAGING_FAILED` finding.
- **`vat skills build` promotes `dist/skills` with the ordinary directory mode** (was `0700`, from
  its temporary staging root, unreadable to group and other), and a refusal after discovery reports
  the skills it found in `examined` (was `0`), each row `status: not-built` (new; was `ok`, beside
  an output path that did not exist — a dry run's rows read `not-built` too). A refusal during
  validation (a git snapshot naming an unreadable file) no longer leaves a `dist/.vat-skills-*`
  staging directory behind, and the previous `dist/skills` is restored.
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
  written, and the leftover is reported as a `PLUGIN_INSTALL_CLEANUP_INCOMPLETE` warning finding at
  the plugin key (new, never overridable; it reached stderr only). Staged and parked trees are dot-named, and
  `vat inventory --user` no longer reads a dot-named directory under a plugin's cache as an
  installed version. The cached version directory takes the plugin's own mode (it was `0700`) —
  applied after the copy, so a read-only plugin directory installs (applying it first aborted the
  process, exit 134, with a read-only staging directory left in `~/.claude`) — and a dangling link
  at its path is replaced instead of failing the install.
- **A RAG database whose table files are damaged is `INPUT_UNREADABLE`** in `vat rag stats` and
  `vat rag query` (was `INTERNAL_ERROR`) — a table manifest that will not open, or data files that
  fail on the first read behind an intact manifest — and **`vat rag clear` removes it**: `clear` no
  longer opens the database it removes, so the documented remedy works. `LanceDBRAGProvider` throws
  a `VatError` coded `RAG_DATABASE_UNREADABLE` (`RAG_DATABASE_UNREADABLE_CODE`, from
  `@vibe-agent-toolkit/utils`) for every failed read of the chunk table.
- **`vat rag index` codes where its database cannot go**: a `--db` that is, or lies under, a file is
  `USAGE_INVALID`; a project `.rag-db` that is a file is `INPUT_UNREADABLE`; a database directory
  it cannot create or write (a read-only parent) is `RUN_INCOMPLETE` — all were `INTERNAL_ERROR`
  from LanceDB.
- **`vat corpus scan` declares `[seed-file]` once**: it registered it twice, so a second operand
  was silently ignored, exit 0, and `--help` printed `[seed-file] [seed-file]`.
