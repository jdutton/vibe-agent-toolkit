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
  - a classified filesystem fault (`FsFaultError`) names the absolute path the OS named
    ("Could not <action> (<errno>): /…"), and every packaging lane publishes a packager's
    source fault with that message as the `SKILL_PACKAGING_FAILED` finding (traced);
  - `agent build` refusing a pipe, socket or device under `scripts/` names it by its absolute
    path in `error.message` ("Agent source cannot be read (not a regular file…): /…/scripts/pipe");
  - a skill source the OS will not read is a fault saying "Could not read the skill source at
    <path>" with the path `resolveAssetReference` resolved, so absolute
    (`skill test run --with name=path:<dir>`).
- **Reproduce:** `vat skill review skills/foo --yaml`, then read `data.source`.
- **Where:** the verbs above; `requireDeclaredSkill` in
  [`configure.ts`](../../packages/cli/src/commands/skill/test/configure.ts);
  `recognisePackageOutput` in [`skill-packager.ts`](../../packages/agent-skills/src/skill-packager.ts);
  [`fs-fault.ts`](../../packages/utils/src/errors/fs-fault.ts) (`FsFaultError`'s message);
  [`builder.ts`](../../packages/agent-skills/src/builder.ts) (the agent-source refusal);
  [`content-hash.ts`](../../packages/agent-skills/src/skill-source/content-hash.ts).
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
  - an over-long comment line in [`resources/check.ts`](../../packages/cli/src/commands/resources/check.ts) near line 1522;
  - the lab's `arm-env.ts` and `verdict/compare.ts` import `compareByCodeUnit` from `fingerprint.ts`.
- **Fix:** tidy them when the file is next touched.

## Plugin install and uninstall

### Two concurrent installs of one plugin version can interleave

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** an install plans against the trees and registry files it reads, then stages, swaps
  and rewrites them, with no lock across the plan and its apply. Two `vat claude plugin install`
  runs of the same plugin can both plan against the same previous state: each swap is atomic and
  each registry file is replaced whole, so no file is ever half-written, but the second run's
  registry edit is computed from what it read before the first one landed. Traced, not run.
- **Where:** `planPackageInstall` in
  [`package-install.ts`](../../packages/claude-marketplace/src/install/package-install.ts),
  `applyTreePlan` in [`apply.ts`](../../packages/utils/src/tree-change/apply.ts)
- **Fix:** take a lock file under the Claude plugins directory for the plan-and-apply, as the
  skill-test harness lock does, and refuse a second run `USAGE_INVALID` while it is held.

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

### `vat agent build` lands a package its own post-build checks fail, and drops those findings

- **Severity:** Minor · **Effort:** M · **User-visible:** yes
- **Mechanism:** `packageSkill` refuses to write a package whose post-build checks emit an error
  (`SkillPackageChecksFailedError`); the agent builder does not apply the same rule. It adds
  `scripts/` and `LICENSE.txt`, which the generated SKILL.md never links, so the packager's
  `PACKAGED_UNREFERENCED_FILE` (an error) fires on every agent that has either — refusing on it
  would refuse those builds outright. `BuildResult` has no findings channel, so the error findings
  of a generated package are dropped and the build exits 0.
- **Reproduce:** an agent whose system prompt links a file that does not exist; `vat agent build`
  exits 0 with a packaged SKILL.md carrying the broken link.
- **Where:** `writeAgentBuild` in [`builder.ts`](../../packages/agent-skills/src/builder.ts)
- **Fix:** declare the builder's own additions to the packager (explicit `files:` dests are exempt
  from the unreferenced-file check), then apply `refuseFailedChecks` as `packageSkill` does.

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

## Git and crawl

### A tracked file deleted but not yet staged is enumerated, then reported unreadable

- **Severity:** Important · **Effort:** S · **User-visible:** yes
- **Mechanism:** the crawl's git route takes its population from `git ls-files`, which lists the
  INDEX. A tracked markdown file removed from the working tree and not yet staged is still in the
  index, so it is enumerated; the read then fails `ENOENT` and the registry files a
  `RESOURCE_UNREADABLE` error for a file that is simply gone. A gate run on an uncommitted tree
  that deletes a tracked `.md` therefore fails until the deletion is staged.
- **Reproduce:** delete a tracked markdown file without `git rm`, then run
  `packages/resources/test/system/project-validation.system.test.ts`: one `RESOURCE_UNREADABLE`
  per deleted file ("was enumerated but could not be read … (ENOENT)"). Staging the deletion, or
  restoring the file, clears it.
- **Where:** the `git ls-files` branch of `crawlDirectorySync` in
  [`file-crawler.ts`](../../packages/utils/src/file-crawler.ts)
- **Fix:** subtract `git ls-files --deleted` from the tracked list (one more git call, no file
  read), with a test that deletes a tracked file unstaged.

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
- **Mechanism:** codes such as `SETTINGS_*` and `AGENT_*` are
  emitted by verbs that read no validation config. Each was made non-overridable by hand, and
  no test asserts the class. A new code from such a verb would be accepted as a
  `validation.severity` key and silently ignored.
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
  - `.changes/v020-stable-foundation.md` still announces as `Breaking` many report-contract moves
    between two release candidates, on surfaces the last stable release never had. The rule says
    those fold into `Added`. (Its filesystem-fault, install and build entries were checked against
    the last stable; the report-contract entries were not.)
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
