# Known defects — open, reproduced or traced, not yet fixed

These are the open defects VAT's maintainers know about. Every entry is either reproduced against
the built CLI or traced in code, and says which. **Delete an entry in the commit that fixes it.**
Do not mark it fixed, strike it through or move it to a "done" list: git holds the history. Add an
entry when a review or a session finds a defect that will not be fixed in the change that found it.

Each entry gives the mechanism, a minimal reproduction, where it lives, the likely fix, an effort
(**S** under about an hour, one package, the fix is clear; **M** more than that; **L** needs a
design or the root cause is unknown) and whether fixing it changes what a user sees. Severity is
the finder's: **Critical** destroys or exposes data, **Important** gives a wrong answer or a wrong
code where a user acts on it, **Minor** everything else. Line numbers are approximate and drift.
Search for the symbol if a line has moved.

No session logistics, dates, commit ids, issue numbers or names of people, adopters or companies.
Routing for other kinds of statement is in [`content-routing.md`](content-routing.md). A failure
that only *looks* like a defect belongs in [`traps.md`](traps.md).

## CLI arguments and config

### An unloadable governing config gets three different answers, and one comment is false

- **Severity:** Minor · **Effort:** M (choose the one answer) · **User-visible:** yes
- **Mechanism:** with the same broken config, each lane answers differently:
  - `skills validate` refuses with `CONFIG_INVALID`;
  - `audit` puts a `SCAN_PATH_UNREADABLE` warning in the document;
  - `claude marketplace validate` logs to stderr only, and its document says nothing. Its comment
    justifies this by `vat verify` reporting the parse error in its other phases, which does not
    hold when the verb runs on its own.

  The audit fallback justifies itself as "can only show more than the adopter asked for, never
  less". That holds for `ignore`. It is false for a `validation.severity` override that raises a
  code to `error`: the finding is then published at its default severity, and the run can exit 0.
- **Reproduce:** use a project with a malformed config and a severity override that raises a
  warning to error. Run `vat claude marketplace validate`: it exits 0.
- **Where:** [`marketplace/validate.ts:500-515`](../../packages/cli/src/commands/claude/marketplace/validate.ts)
  (`resolveProjectValidationConfig`),
  [`audit.ts:1353-1375`](../../packages/cli/src/commands/audit.ts)
- **Fix:** publish the same `SCAN_PATH_UNREADABLE` finding in the marketplace document, and correct
  both comments.

### Published documents carry absolute paths outside `data.root`

- **Severity:** Minor · **Effort:** L (choose one rule and apply it across verbs) · **User-visible:** yes
- **Mechanism:** the stated convention is that `data.root` is the only absolute path. These break it:
  - `skill review --yaml` puts an absolute path in `data.source`;
  - `inventory` does the same in `data.inventory.path`;
  - `doctor` does the same in `currentDir`, `projectRoot` and `configPath`;
  - every "Path does not exist" refusal puts one in `error.message`;
  - `skill test configure <undeclared>` names the config file by its absolute path in
    `error.message` ("No skill named 'typo' is declared by /…/vibe-agent-toolkit.config.yaml");
  - `skills package -o <occupied>` (dry or real) puts the output's absolute path in
    `error.message` ("output occ: /…/occ already exists");
  - node's errno text, which names an absolute path, is interpolated unchanged into
    `SKILL_PACKAGING_FAILED` messages for OS refusals (`withFsAttribution`'s `reason`; traced);
  - `agent build` refusing a pipe, socket or device under `scripts/` names it by its absolute
    path in `error.message` ("Agent source cannot be read (not a regular file…): /…/scripts/pipe");
  - `SkillSourceUnreadableError` says "Cannot read the skill source at <path>" with the path
    `resolveAssetReference` resolved, so absolute (`skill test run --with name=path:<dir>`).
- **Reproduce:** `vat skill review skills/foo --yaml`, then read `data.source`.
- **Where:** the verbs above; `requireDeclaredSkill` in
  [`configure.ts`](../../packages/cli/src/commands/skill/test/configure.ts);
  `checkPackageOutput` in [`skill-packager.ts`](../../packages/agent-skills/src/skill-packager.ts);
  [`fs-attribution.ts:135`](../../packages/agent-skills/src/fs-attribution.ts) for the errno text;
  [`builder.ts`](../../packages/agent-skills/src/builder.ts) (the agent-source refusal);
  [`source-unreadable.ts`](../../packages/agent-skills/src/skill-source/source-unreadable.ts).
- **Fix:** relativize to a stated root, or document each exception in the schema docstrings.

### A Commander usage error publishes no document

- **Severity:** Minor · **Effort:** L (contract decision) · **User-visible:** yes
- **Mechanism:** every node gets `exitOverride()` and `allowExcessArguments(false)`, so an unknown
  option, a bad `.choices()` value and an operand a verb never declared all end as a
  `CommanderError`. `bin.ts` maps that to exit 2 and exits with nothing on stdout, for every verb.
  This is deliberate. Even so, "every document verb publishes its document on failure too" holds
  only for refusals raised inside a verb. `validate`, `build` and `verify` refuse excess operands
  by hand instead (`marksOperandRefusalByHand`), throwing `USAGE_INVALID` inside the action, so the
  same mistake takes the verb's own refusal path there and commander's document-less ending
  everywhere else.
- **Reproduce:** traced. Any verb with an unknown option, such as `vat resources validate --bogus`,
  should exit 2 with an empty stdout.
- **Where:** [`bin.ts:222-231`](../../packages/cli/src/bin.ts),
  [`command-tree.ts`](../../packages/cli/src/command-tree.ts) (`applyCommandTreePolicy`),
  [`commander-ending.ts`](../../packages/cli/src/utils/commander-ending.ts)
- **Fix:** decide before 0.2.0 stable. Either publish a `USAGE_INVALID` document from the ending
  handler, or state the exception in the report contract.

### A config warning is headed "Invalid configuration in …"

- **Severity:** Minor · **Effort:** S · **User-visible:** yes
- **Mechanism:** a config whose only problems are unknown keys is accepted with a warning, but the
  warning is rendered by the same formatter as the refusal. Its first line reads "Invalid
  configuration in …" for what its own body calls a warning.
- **Reproduce:** `vat claude plugin build` with a config that carries an unknown root key.
- **Where:** [`config-issues.ts:188-198, 331`](../../packages/resources/src/config-issues.ts)
  (`formatConfigValidationError`, called from `parseConfigAllowingUnknownKeys`)
- **Fix:** give the formatter a subject for the warning case, and pass it from the unknown-keys path.

### One broken link, two finding codes

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** the same line of the same file gets a different code depending on the lane:
  - `skills validate`, and `audit` when the config loaded, report `LINK_MISSING_TARGET`;
  - `skills install`, `skills package`, and `audit` when the config is unloadable, report
    `LINK_INTEGRITY_BROKEN`.

  A `validation.severity` override on one name does not reach the other lanes.
- **Reproduce:** use a skill with one broken link, then compare `vat skills validate` with
  `vat skills package`.
- **Where:** the link validators in [`agent-skills`](../../packages/agent-skills/src/validators/)
- **Fix:** one code for one cause, emitted by one validator that every lane calls.

### `command-refusal.ts` imports the whole agent-skills barrel for six constants

- **Severity:** Minor · **Effort:** S · **User-visible:** no
- **Mechanism:** the refusal map exists so a helper that only needs to refuse does not load heavy
  modules. It still imports six code constants from `@vibe-agent-toolkit/agent-skills`, whose
  package exports only `.`, so loading the map loads the whole barrel.
- **Where:** [`command-refusal.ts:22-29`](../../packages/cli/src/utils/command-refusal.ts),
  [`agent-skills/package.json`](../../packages/agent-skills/package.json) (`exports`)
- **Fix:** add a light agent-skills subpath that exports the code constants, and import from it.

### `vat skill test run` with an expired `claude` login is `INTERNAL_ERROR`

- **Severity:** Important · **Effort:** M · **User-visible:** yes
- **Mechanism:** preflight's auth check reads `claude auth status --json` and accepts
  `loggedIn: true`, which does not prove the credential is still live. The run then spawns the
  grader, which exits non-zero, and `eval-grader.ts` throws every non-zero grader exit as an
  `InternalHarnessError`. An expired login is therefore published as a defect in VAT, "Grader
  exited non-zero", instead of an auth refusal the user can act on.
- **Reproduce:** observed with an expired subscription login: `vat skill test run <skill>
  --i-understand-this-runs-skill-code` exits 2 `INTERNAL_ERROR`.
- **Where:** [`eval-grader.ts:292-295`](../../packages/agent-skills/src/skill-test/eval-grader.ts),
  [`auth-resolver.ts:46, 85`](../../packages/utils/src/skill-test/auth-resolver.ts),
  [`preflight.ts`](../../packages/agent-skills/src/skill-test/preflight.ts)
- **Fix:** have preflight prove the credential with a cheap authenticated call, and code a spawn
  that fails on authentication as the preflight's auth refusal rather than a harness defect.

### Code-hygiene leftovers

- **Severity:** Minor · **Effort:** S · **User-visible:** no
- **Mechanism:** each item below changes no behaviour:
  - [`plugin/install.ts:22`](../../packages/cli/src/commands/claude/plugin/install.ts) has a long single-line import;
  - the literal `'agent-skill'` is used twice in [`skill-validator.ts:715-716`](../../packages/agent-skills/src/validators/skill-validator.ts);
  - `CLEAN_SENTENCE` is typed as `Partial<Record>` ([`describe-issues.ts:19`](../../packages/agent-skills/src/validators/describe-issues.ts));
  - `graderSeverityToShared` is a one-line wrapper ([`friction-schema.ts:27`](../../packages/agent-skills/src/skill-test/friction-schema.ts));
  - prose sits between two `@param` tags in [`cache/clear.ts`](../../packages/cli/src/commands/cache/clear.ts) (`partialOutcome`);
  - an over-long comment line in [`resources/check.ts`](../../packages/cli/src/commands/resources/check.ts) near line 1522;
  - the lab's `arm-env.ts` and `verdict/compare.ts` import `compareByCodeUnit` from `fingerprint.ts`.
- **Fix:** tidy them when the file is next touched.

## Plugin install and uninstall

### Installed plugins get relative symlinks rewritten to absolute links into the source tree

- **Severity:** Important · **Effort:** S · **User-visible:** yes
- **Mechanism:** `replaceDirectory`, which makes both the marketplace copy and the cache copy, calls
  `cpSync` without `verbatimSymlinks: true`, which resolves a relative link target to an absolute
  path. The "installed" plugin then reads the developer's working copy, and its links dangle once
  the source is moved, such as a temp clone or an extracted tarball.
- **Reproduce:** use a plugin with `alias -> real` and run `installPlugin`. In both the
  marketplace tree and the cache, `alias` then points at `<source>/real`.
- **Where:** [`plugin-registry.ts:212`](../../packages/claude-marketplace/src/install/plugin-registry.ts)
  (the `cpSync` in `replaceDirectory`)
- **Fix:** pass `verbatimSymlinks: true`, and add a re-install test with a relative link.
  **Decision:** with `verbatimSymlinks`, a relative link that resolves outside the plugin dangles
  in the cache. Refuse such links (the tree-copy lane already does), or keep resolving those alone.

### Uninstalling a plugin installed from a read-only source fails `EACCES`

- **Severity:** Minor · **Effort:** S · **User-visible:** yes
- **Mechanism:** install copies the source root's mode onto both the marketplace copy and the cache
  copy. `removePluginDirs` then removes each tree with a plain recursive `rm`. A root that took
  mode 0555 refuses the removal of its own entries, so uninstall fails partway with
  `RUN_INCOMPLETE`. Install's own `removeTree` already chmods the root first. Reproduced through
  the library: `installPlugin` with a 0555 `pluginDir`, then `uninstallPlugin`, fails `EACCES`
  (`CLAUDE_USER_STATE_WRITE_FAILED`). Not reproduced through the CLI: `vat claude plugin install
  <dir>` with a 0555 plugin dir copies the plugin roots at 0755, and install and uninstall both
  exit 0.
- **Where:** [`plugin-uninstall.ts:134, 140`](../../packages/claude-marketplace/src/install/plugin-uninstall.ts),
  [`plugin-registry.ts:252-256`](../../packages/claude-marketplace/src/install/plugin-registry.ts)
  (`removeTree`, the pattern to copy)
- **Fix:** chmod each root before removing it, as `removeTree` does, or share `removeTree`.

### `vat claude plugin install --dev` deletes the installed marketplace before rebuilding it

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** `devInstallMarketplace` removes the installed marketplace directory, then copies
  its non-plugin content and links each plugin's skills one by one. A failure partway (a refused
  copy, a symlink that cannot be made) leaves a partial tree on disk that `registerPlugin` never
  registers. The non-dev lanes stage and swap through `replaceDirectory`; this lane builds its
  tree in several steps, so it needs a staging root of its own. Traced, not run.
- **Where:** [`install.ts:847-881`](../../packages/cli/src/commands/claude/plugin/install.ts)
  (`devInstallMarketplace`)
- **Fix:** build the whole dev marketplace under a staging directory, then swap it in with
  `replaceDirectory`.

### The plugin-source readability probe re-implements `openEachFileForReading`

- **Severity:** Minor · **Effort:** S · **User-visible:** no
- **Mechanism:** `requirePluginSource` lists the tree recursively and opens each regular file,
  skipping links. It is exported from `claude-marketplace` and now gates every copy install —
  `installPlugin`, each marketplace of a plugin-tree install, and a skill installed from a path.
  `openEachFileForReading` in utils is the same probe, written for copiers. Two copies of one
  probe can drift on what counts as readable, and the drift now reaches every install lane.
- **Where:** [`plugin-registry.ts:133-150`](../../packages/claude-marketplace/src/install/plugin-registry.ts),
  [`install.ts:1150, 1217`](../../packages/cli/src/commands/claude/plugin/install.ts),
  [`fs-utils.ts:1321`](../../packages/utils/src/fs-utils.ts)
- **Fix:** call `openEachFileForReading` and wrap its error with `pluginSourceUnreadable`, using the
  error's `path`.

### `vat claude plugin install <zip> --dry-run` passes a zip the real run refuses

- **Severity:** Minor · **Effort:** S · **User-visible:** yes
- **Mechanism:** the dry run does not extract the archive, so nothing checks that its entries
  can coexist on disk. A zip holding both a file `a` and a file `a/b` passes the dry run, and the
  real run refuses it `INPUT_UNREADABLE` when the extraction collides. The dry run is not a
  faithful preview.
- **Reproduce:** build a zip with entries `a` and `a/b`. `vat claude plugin install x.zip
  --dry-run` exits 0; without `--dry-run` it exits 2 `INPUT_UNREADABLE`.
- **Where:** `handleZipInstall` in [`install.ts`](../../packages/cli/src/commands/claude/plugin/install.ts)
- **Fix:** extract into the dry run's temp directory too (it removes nothing), or check the entry
  names for a file/directory clash before either run extracts.

## Packaging and build

### A library packaging validation dropped a link silently in a repo with no config file

- **Severity:** Minor (cause unknown) · **Effort:** L · **User-visible:** yes
- **Mechanism:** observed, not traced. `validateSkillForPackaging` called as a library in a git
  repository with no `vibe-agent-toolkit.config.yaml` reported `fileCount: 1` for a skill that
  links a second file, and recorded no exclusion for the link. With a config file present, the
  same call walked the link. A link the walk drops without a word is a packaged skill missing a
  file nobody was told about.
- **Reproduce:** a git repo with a `SKILL.md` that links `ref.md`, no config file; call
  `validateSkillForPackaging` and read its file count. Add an empty config file and call it again.
- **Where:** [`packaging-validator.ts`](../../packages/agent-skills/src/validators/packaging-validator.ts)
  and the crawl it delegates to
- **Fix:** root-cause first: find which population or exclusion rule the absent config changes.

### A failed `vat claude plugin build` destroys the previous marketplace tree

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** `buildMarketplace` removes `dist/.claude/plugins/marketplaces/<name>` before it
  builds anything. A run refused partway therefore leaves no marketplace at all.
  `skills build` stages and swaps to avoid exactly this.
- **Reproduce:** build once. Then give a plugin-local skill a missing `files:` source and build
  again: exit 2, and `find dist/.claude -type f` is empty.
- **Where:** [`plugin/build.ts:591-592`](../../packages/cli/src/commands/claude/plugin/build.ts)
- **Fix:** build into a staging directory and swap it in on success, as `skills build` does.

### `vat claude plugin build` stops the whole build at the first refused skill

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** the first plugin skill refused with `SKILL_PACKAGING_FAILED` ends the run, so
  other plugins' findings are never reported. The help and changelog state this as a known gap.
- **Where:** [`plugin/build.ts:936-1012`](../../packages/cli/src/commands/claude/plugin/build.ts)
  (the "KNOWN GAP" comment and `SkillPackagingStop`)
- **Fix:** contain refusals per skill, as `skills build` does, and publish every finding.

### `vat skills package -f npm` advertises a format it does not produce

- **Severity:** Minor · **Effort:** M (implement or drop the format) · **User-visible:** yes
- **Mechanism:** `createNpmPackage` writes a `package.json` and returns a placeholder path. No
  `.tgz` is ever made, yet `--help` lists `npm`.
- **Reproduce:** `vat skills package … -f directory,npm` exits 0, and no tarball exists.
- **Where:** [`skill-packager.ts:2868-2890`](../../packages/agent-skills/src/skill-packager.ts)
- **Fix:** run `npm pack` on the written directory, or remove `npm` from the formats.

### `existsSync` reads `EACCES` as "absent" in plugin build and the inventory extractors

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** `existsSync` returns `false` when a parent directory denies search. These cases
  then behave as if the file were absent:
  - a project `LICENSE`, `README.md` or `CHANGELOG.md` is skipped;
  - a plugin source directory is treated as missing;
  - a plugin or marketplace manifest is treated as missing.

  The run continues instead of refusing. The shared policy predicate is `pathPresent`.
- **Where:** [`plugin/build.ts:540, 1223`](../../packages/cli/src/commands/claude/plugin/build.ts),
  [`extract-plugin.ts:148`](../../packages/claude-marketplace/src/inventory/extract-plugin.ts),
  [`extract-marketplace.ts:57`](../../packages/claude-marketplace/src/inventory/extract-marketplace.ts)
- **Fix:** sweep these sites onto `pathPresent`, and code an unstatable path as `INPUT_UNREADABLE`.

## RAG

### `vat rag stats` publishes a fabricated `lastIndexed` and a constant `examined`

- **Severity:** Important · **Effort:** M · **User-visible:** yes (the schema changes)
- **Mechanism:** `getStats` returns `new Date(0)` for a database with no chunk table, and
  `new Date()`, the current time, for a populated one ("Would need to track this separately").
  Neither value answers "when was this last indexed". Also, `examined` is the constant
  `DATABASES_OPENED = 1`, so the verb's `whenZero` can never fire.
- **Reproduce:** run `vat rag stats` twice a minute apart on an unchanged index. `lastIndexed`
  moves.
- **Where:** [`lancedb-rag-provider.ts:484, 505`](../../packages/rag-lancedb/src/lancedb-rag-provider.ts),
  [`stats-command.ts:18, 26`](../../packages/cli/src/commands/rag/stats-command.ts),
  [`admin-schema.ts:30`](../../packages/cli/src/commands/rag/admin-schema.ts)
- **Fix:** record the index time when `rag index` writes, and make `lastIndexed` nullable.

### A mid-run `rag index` failure discards the partial counts

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** a throw inside `indexResources` ends the run with `NOTHING_FINISHED`. The
  provider exposes no partial counters, so the report cannot say what was indexed. Exit 2 is
  honest; `data` is empty.
- **Where:** [`rag/index-command.ts:167-181`](../../packages/cli/src/commands/rag/index-command.ts)
- **Fix:** have the provider report progress, and publish it as the refusal's finished work.

## Audit and validators

### `vat audit` counts no unreadable path when the refusal rides on a host result

- **Severity:** Minor · **Effort:** S · **User-visible:** yes
- **Mechanism:** `data.counts.pathsUnreadable` counts only results of type `unknown` whose every
  issue is `SCAN_PATH_UNREADABLE`. Several validators file that code as one issue on a host result
  instead: a plugin, marketplace or registry manifest the OS refused, the agent-instruction
  presence check, and the packaged-size check. The document then publishes a
  `SCAN_PATH_UNREADABLE` finding while `pathsUnreadable` stays 0, and the refused path is counted
  as a scanned file. Traced.
- **Where:** [`audit.ts:3219, 3234`](../../packages/cli/src/commands/audit.ts)
  (`isUnreadablePathResult`, `countFilesByStatus`)
- **Fix:** decide what the count means, then either count every `SCAN_PATH_UNREADABLE` issue's
  path or state in the schema docstring that only whole-path refusals are counted.

### `plugin-validator` duplicates the agent-skills manifest-read classifier

- **Severity:** Minor · **Effort:** S · **User-visible:** no
- **Mechanism:** `pluginManifestReadIssue` repeats `manifestReadFailure` line for line: absence is
  the validator's "missing" finding, another OS refusal is `SCAN_PATH_UNREADABLE` naming only the
  errno, anything else is rethrown. The agent-skills helper says it exists so the manifest
  validators "cannot drift", but the claude-marketplace copy can.
- **Where:** [`plugin-validator.ts:220-234`](../../packages/claude-marketplace/src/validators/plugin-validator.ts),
  [`marketplace-validator.ts:137-158`](../../packages/agent-skills/src/validators/marketplace-validator.ts)
- **Fix:** export `manifestReadFailure` from the agent-skills index (claude-marketplace already
  depends on agent-skills) and call it with the plugin's missing-manifest finding.

## Git and crawl

### A full disk under the repository is `INTERNAL_ERROR` "not a git repository" in every crawl lane

- **Severity:** Important · **Effort:** L · **User-visible:** yes
- **Mechanism:** the git snapshot fails when git's temp index cannot be written (`ENOSPC`).
  `unreadableSnapshotRefusal` recognises only an unreadable file, so it falls through to an
  uncoded "git did not answer … it is not a git repository". That is a user's environment
  published as a VAT defect, with a false diagnosis attached. On this path the probe also opens
  every listed file before returning `undefined`.
- **Reproduce:** put the project on a full volume (a 2 MiB disk image works). `skills validate`,
  `resources validate`, `resources scan`, `claude context` and `rag index` then all exit 2
  `INTERNAL_ERROR`.
- **Where:** [`crawl-source.ts:632-635`](../../packages/resources/src/projection/crawl-source.ts),
  [`git-snapshot.ts:330`](../../packages/utils/src/git-snapshot.ts) (`unreadableSnapshotRefusal`)
- **Fix:** a structural answer to an output-side errno during *any* crawl, rather than one more
  call site: carry git's stderr and errno through the snapshot result, and code `ENOSPC`/`EROFS`
  as `RUN_INCOMPLETE`.

### The same tree flips between exit 1 and exit 2 across runs

- **Severity:** Minor · **Effort:** L (root cause unknown) · **User-visible:** yes
- **Mechanism:** a tracked, linked `ref.md` was `chmod 000` after `git add`. Consecutive
  `vat skills build` runs then alternated:
  - some runs gave `INPUT_UNREADABLE` from the git snapshot, exit 2;
  - others gave a `LINK_TARGET_UNREADABLE` finding, exit 1.

  A `git status` between runs changed which one appeared next. The suspected cause is git's stat
  cache sometimes skipping the re-read; this has not been traced. A CI gate sees different exit
  codes for one input.
- **Reproduce:** as above. Run `vat skills build` four times, with one `git status` in between.
- **Fix:** root-cause first; the likely shape is to refresh the index stat data before the
  snapshot.

### Raw git stderr and a false projection-store warning precede a coded refusal

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** before the `INPUT_UNREADABLE` refusal, stderr carries git's own lines
  (`error: unable to index file …`, `fatal: updating files failed`). It also carries the
  projection-store warning "…is not inside a readable git repository … Populating without a
  cache", which is false.
- **Reproduce:** `chmod 000` any file in a git project, then run `vat skills validate`.
- **Where:** [`git-snapshot.ts`](../../packages/utils/src/git-snapshot.ts) (child stderr
  inheritance), the projection-store open path in `resources`
- **Fix:** capture git's stderr into the refusal, and make the store's warning name the real
  failure.

## Windows

### The plugin cache swap has no rename retry, and a failed restore leaves the version absent

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** `swapIn` uses bare `renameSync`. On Windows, renaming a freshly written tree can
  fail transiently with `EPERM`, `EACCES` or `EBUSY` (AV, the indexer). If the forward rename and
  then the restore both fail, the restore's error replaces the original. The destination is then
  absent while the registry points at it. Two concurrent installs of one version can also
  interleave. Traced, not run.
- **Where:** [`plugin-registry.ts:265-285`](../../packages/claude-marketplace/src/install/plugin-registry.ts)
- **Fix:** retry the renames with backoff as graceful-fs does, and keep the original error when
  the restore fails.

### `isSingleFsSegment` does not consider Win32 name normalisation

- **Severity:** Minor (unverified; raise it if a reproduction shows traversal) · **Effort:** S ·
  **User-visible:** yes
- **Mechanism:** the guard refuses `.`, `..`, separators, NUL and a drive prefix. Three Windows
  name rules are not covered:
  - Win32 strips trailing dots and spaces from path components, so `".. "` or `"..."` may resolve
    as a parent reference;
  - `a:b` names an NTFS alternate data stream;
  - `CON`, `NUL` and `COM1` are reserved device names.

  Plugin names, marketplace names and versions all pass through this guard before a
  `rm`/`rename`. None of this has been exercised on Windows.
- **Where:** [`path-core.ts:157-167`](../../packages/utils/src/path-core.ts)
- **Fix:** run the hostile-name set on the Windows box first. Then refuse trailing dot/space, `:`
  and reserved device names.

## Test-suite health

### Tests in the wrong tier

- **Severity:** Minor · **Effort:** M · **User-visible:** no
- **Mechanism:** the tier table puts "spawns child processes" in System. 19 of the 60
  `packages/cli/test/integration` files spawn a process directly, counted by grepping for
  `child_process`, `executeCli`, `bin.js`, `spawnSync` and `execSync`; three more run git through
  a helper. Outside the CLI, nine of the 18 `utils` integration files spawn too: seven directly
  (`eslint-recommended-config`, `file-crawler`, `git-ignore-oracle-parity`, `git-utils`,
  `safe-exec`, `spawn-hardened`, `spawn-claude-watchdog`) and two through the git helpers
  (`git-hook-env`, `git-snapshot-unreadable`).
- **Where:** [`packages/cli/test/integration/`](../../packages/cli/test/integration/),
  [`packages/utils/test/integration/`](../../packages/utils/test/integration/)
- **Fix:** move each spawning file to `*.system.test.ts` by rename. Never raise a budget or add
  an allowlist entry for one.

### Exit-code matrix scenarios that never run on CI

- **Severity:** Minor · **Effort:** M · **User-visible:** no
- **Mechanism:** three `ok` scenarios skip on every CI runner, because the runners provision none
  of their prerequisites:
  - `skill test run → ok` needs a `claude` binary;
  - `rag query → ok` needs the cached ONNX model;
  - `doctor → ok` needs the live npm registry, and its probe and the child each ask separately,
    so the two can race.

  The skips are named, but these rows are verified only on a developer's machine.
- **Where:** [`exit-code-matrix.ts:600, 828, 881`](../../packages/cli/test/system/test-helpers/exit-code-matrix.ts)
- **Fix:** make each hermetic:
  - put a fake `claude` and a fake `npm` on the child's `PATH`;
  - add a tiny fixture embedding model;
  - or provision both in CI.

### Test files are never typechecked

- **Severity:** Minor · **Effort:** M · **User-visible:** no
- **Mechanism:** `tsc --build` covers `src` only. A latent `TS2345` sits at `cli-runner.ts:34`:
  `yamlContent` is `string | undefined` and is passed to `yaml.parse`. Narrowing gaps in tests
  pass review because nothing compiles them.
- **Where:** [`cli-runner.ts:33-34`](../../packages/cli/test/system/test-helpers/cli-runner.ts)
- **Fix:** add a `tsconfig.test.json` per package with a `typecheck:tests` step, and fix what it
  reports.

### Nothing enforces that a non-overridable code is refused as an override key

- **Severity:** Minor · **Effort:** M · **User-visible:** no
- **Mechanism:** codes such as `SETTINGS_*`, `AGENT_*`, `SKILL_PACKAGING_OUTPUT_FAILED` and
  `PLUGIN_SOURCE_UNREADABLE` are emitted by verbs that read no validation config. Each was made
  non-overridable by hand, and no test asserts the class. A new code from such a verb would be
  accepted as a `validation.severity` key and silently ignored.
- **Where:** [`validation-codes.ts`](../../packages/schema/src/validation-codes.ts)
- **Fix:** derive overridability from the emitting lane, or assert it per code in the schema tests.

### `skill test run`'s `evals[]` row is never exercised by a tagged example

- **Severity:** Minor · **Effort:** S · **User-visible:** no
- **Mechanism:** the populated `skill test run` example is a dry run, so its `data.evals` is `[]`.
  No tagged example carries an `{ id, passed }` row, so the row's schema is never checked against
  a real document. Producing one needs a real graded run.
- **Where:** [`skill-test.md`](../../packages/cli/docs/skill-test.md) tagged examples,
  [`run-schema.ts:31`](../../packages/cli/src/commands/skill/test/run-schema.ts)
- **Fix:** add a trimmed example from a real run with at least one graded eval.

### The committed verdict deltas are never reconciled against an observation in the gate

- **Severity:** Minor · **Effort:** L · **User-visible:** no
- **Mechanism:** the gate checks that `verdict-deltas.yaml`'s changelog references resolve both
  ways. Whether its entries match what the two builds actually do is shown only by a local
  crucible run over a private subjects file, and that run leaves no artifact.
- **Where:** [`verdict-deltas.yaml`](../../packages/lab/data/verdict-deltas.yaml)
- **Fix:** record which tree the last passing crucible ran on, or commit a public subject the gate
  can run.

### A `resources query` row declared `reshaped` proves only the exit code

- **Severity:** Minor · **Effort:** M · **User-visible:** no
- **Mechanism:** a declared reshape covers every document difference on the row. A
  `resources query` document has no findings layer, so a candidate returning different *rows*
  passes.
- **Where:** [`verdict-deltas.yaml`](../../packages/lab/data/verdict-deltas.yaml) (`resources-query:sql/…`)
- **Fix:** compare `data.rows` as the verdict for `resources-query` rows, or note the limit beside
  the entry.

### Verdict-delta markers have two blind spots

- **Severity:** Minor · **Effort:** M · **User-visible:** no
- **Mechanism:** a `<!-- verdict-delta:… -->` marker that sits outside any bullet, and that
  nothing cites, is invisible to the both-ways test. Separately, the markers ship into
  `CHANGELOG.md` at the stable fold. They are HTML comments, so they do not render, but they are
  noise in the file.
- **Where:** [`deltas.ts`](../../packages/lab/src/facets/verdict/deltas.ts),
  [`committed-verdict-deltas.integration.test.ts`](../../packages/lab/test/integration/committed-verdict-deltas.integration.test.ts)
- **Fix:** refuse an orphan marker, and strip markers in the stable fold once the deltas file is
  re-baselined.

## Docs

### The changelog needs consolidating before 0.2.0 stable

- **Severity:** Important · **Effort:** L · **User-visible:** yes
- **Mechanism:** two problems:
  - `.changes/v020-report-contract.md` announces as `Breaking` many moves between two release
    candidates, on surfaces the last stable release never had. The rule says those fold into
    `Added`.
  - `CHANGELOG.md` `[Unreleased]` still states behaviour that has changed: Node `>= 22.13.0`
    (lines 85-86, 442), `vat rag index` "`status: partial`" (125, 988), "`system-error`" (804),
    and two `Breaking` entries for one RAG filter change.

  Some of the `rc`-only bullets carry `verdict-delta` markers that the lab test requires. Those
  markers must move to the `Added` bullets in the same change.
- **Where:** [`CHANGELOG.md`](../../CHANGELOG.md), [`.changes/`](../../.changes/)
- **Fix:** rewrite `[Unreleased]` against the last stable, fold the fragments, and re-point every
  `changelog:` reference in `verdict-deltas.yaml`.

### Nothing checks the release-notes size before a stable publish

- **Severity:** Important (fails the publish after npm has already published) · **Effort:** M ·
  **User-visible:** no
- **Mechanism:** `publish.yml` passes the extracted changelog section to
  `gh release create --notes-file` after npm publish and both marketplace publishes. The folded
  section is about 157 KB. GitHub's limit on a release body is unmeasured; 125,000 characters is
  the figure recalled. `pre-publish --release-readiness` has no size check. The rule file also
  cites a vendor claim ("states no maximum") that is not cached under `docs/external/`.
- **Where:** [`pre-publish-check.ts`](../../packages/dev-tools/src/pre-publish-check.ts),
  [`changelog-adopter-visible.md`](../../.claude/rules/changelog-adopter-visible.md)
- **Fix:** measure the limit, add a size check to release-readiness, and cache the vendor page.
