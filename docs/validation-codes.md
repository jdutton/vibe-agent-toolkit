# VAT Validation Codes

For the project's *stance* on what each category of code exists to enforce — the reasoning behind every default severity and the confidence level we attach to each — see [Skill Quality and Compatibility — VAT's Stance](./skill-quality-and-compatibility.md). That doc articulates what VAT believes; this doc is the code-level reference.

See [validation-rule-design.md](./validation-rule-design.md) for the rule-addition policy, default-severity guidance, and graduation path that governs every code in this reference.

This reference lists every overridable validation code VAT emits, plus the two meta-codes. Use it to interpret CLI output, configure `validation.severity` / `validation.allow`, and understand default behavior.

## Severity Model

- **`error`** — emit and **block** the build.
- **`warning`** — emit, do not block.
- **`ignore`** — do not emit (check still runs; result is discarded).
- **`info`** — structural reports (inventory, file counts); outside this framework, always emitted, never block.

Both `warning` and `info` are non-failing — neither ever flips the exit code; `info` is the quieter, display-only level (structural reports and low-confidence observations) while `warning` signals something the author should address.

No per-code blocking/non-blocking exceptions. If severity is `error`, it blocks. Every code.

## Configuring

In `vibe-agent-toolkit.config.yaml` under `skills.defaults` or `skills.config.<name>`:

```yaml
skills:
  config:
    my-skill:
      validation:
        severity:
          LINK_DROPPED_BY_DEPTH: error
        allow:
          LINK_TO_GITIGNORED_FILE:
            - paths: ["internal/*.json"]
              reason: "generated at install time, deliberately untracked"
              expires: "2026-09-30"
          SKILL_LENGTH_EXCEEDS_RECOMMENDED:
            - reason: "whole-skill concern; paths defaults to ['**/*']"
```

`validation.severity` sets class-level behavior; `validation.allow` suppresses specific `(code, path)` instances with an audit trail. `paths` is optional on allow entries and defaults to `["**/*"]` (the whole skill). Full docs at the VAT agent-authoring skill.

## Where an issue points — the four anchors

Every issue names up to four independent things, and each has its own field. None
is ever packed into another with a separator:

| Field | Means | Example |
|---|---|---|
| `location` | **The file you would open to fix this**, as a project-relative POSIX path | `packages/cli/SKILL.md` |
| `line` | 1-based line within `location` | `24` |
| `field` | Dotted pointer *inside* that document | `frontmatter.description` |
| `link` | A link href or target the issue is about — never the file to open | `./refs/missing.md` |

`location` is **always relative** and always forward-slashed, so a consumer can
resolve every finding against one known root, and a CI log never carries a
developer's home directory. Human output renders these as
`path:line (field)`.

A **link** finding is anchored to the file that *contains* the link, with the
target in `link`. Anchoring to the target would, for a missing target, name a
path that does not exist.

### What `validation.allow` globs match

`paths` entries are matched against an issue's **`location`** or its **`link`**.
For link codes, prefer naming the containing files:

```yaml
allow:
  LINK_OUTSIDE_PROJECT:
    - paths: ["resources/skills/**"]
      reason: "cross-repo text pointers, intentionally not bundled"
```

Globs written against a link's resolved *target* are depth-fragile — picomatch's
`**` does not cross a leading `../`, so each extra level of nesting needs its own
`../../../…` pattern.

## Command Scope

| Command | Severity applied | `allow` applied | Blocks on error |
|---|---|---|---|
| `vat skills build` | ✓ | ✓ | Yes (exit 1) |
| `vat skills validate` | ✓ | ✓ | Yes (exit 1) |
| `vat resources validate` | ✓ | ✓ | Yes (exit 1) |
| `vat audit` | Display grouping only | ✗ | No (always exit 0) |

## Skill-resource rule catalog (single source of truth)

These are the intent-aware skill-resource codes decided by the shared verdict
engine (issue #129). The table below is the **spine**: its `Severity`,
`Description`, and `Fix headline` cells are asserted **equal to** the
`CODE_REGISTRY` entries by `packages/agent-skills/test/docs/validation-codes.test.ts`,
so the registry, this doc, and the runtime cannot drift. The runtime `message`
is dynamic (the headline plus per-issue detail such as the link href) and is not
asserted here. The longer "why / when it's fine / how to override" prose lives
once in each code's section below (linked from the `Code` cell).

<!-- BEGIN:rule-catalog (generated from CODE_REGISTRY; cells are asserted equal by the docs test) -->

| Code | Severity | Description | Fix headline |
|---|---|---|---|
| [`LINK_OUTSIDE_PROJECT`](#link_outside_project) | error | Markdown link points to a file outside the project root. | Move the target inside the project or remove the link. Use validation.allow if the reference is intentional and cross-project. |
| [`LINK_TARGETS_DIRECTORY`](#link_targets_directory) | error | A typed single-file reference (e.g. a packaging `files:` source entry) resolves to a directory instead of a file. | Point the `files:` source (or other single-file reference) at a specific file, not a directory. Navigational prose links to a directory are valid and do not trigger this code. |
| [`LINK_TO_UNBUNDLED_DIRECTORY`](#link_to_unbundled_directory) | warning | Markdown link targets a directory; directories are never bundled, so the target did not ship and the packaged link points at nothing. | Link the specific file inside the directory that the prose means — a directory cannot be packaged, and VAT does not resolve one to an index file. Set severity.LINK_TO_UNBUNDLED_DIRECTORY to ignore if the link is meant for a reader browsing the repository rather than for the packaged bundle. |
| [`LINK_TO_NAVIGATION_FILE`](#link_to_navigation_file) | warning | Markdown link targets a navigation file (README.md, index.md, etc.) which was excluded from the bundle. | Link to the specific content instead of the navigation file, or set severity.LINK_TO_NAVIGATION_FILE to ignore if this is intentional. |
| [`LINK_TO_AGENT_INSTRUCTION_FILE`](#link_to_agent_instruction_file) | error | Markdown link targets a repo-internal agent-instruction file (CLAUDE.md, AGENTS.md, GEMINI.md) that no explicit files: entry declares; it is not bundled and the link is stripped from the packaged content. | Link the specific content the file describes; point the link at the file's canonical home as an absolute URL; or extract the shared part into a document intended for distribution. To ship the file deliberately, name it in an explicit (non-glob) skills.config.<name>.files entry — the file is then bundled and this link is rewritten to the declared dest. |
| [`LINK_TO_GITIGNORED_FILE`](#link_to_gitignored_file) | error | Markdown link targets a gitignored file; risks leaking ignored data into the bundle. | Link to a non-ignored file or adjust .gitignore. Allow the specific path via validation.allow if the risk has been reviewed. If the target is a build artifact, declare it under skills.config.<name>.files instead. |
| [`LINK_MISSING_TARGET`](#link_missing_target) | error | Markdown link target does not exist on disk and is not a declared build artifact. | Fix the link path, create the file, or declare it under skills.config.<name>.files as a build artifact. |
| [`LINK_TARGET_UNREADABLE`](#link_target_unreadable) | error | Markdown link target exists on disk but could not be read, so it was neither classified nor bundled. Most often permissions; also a change racing the walk. | Fix the permissions on the target, or investigate what changed it mid-walk, then re-run. Set severity.LINK_TARGET_UNREADABLE to warning if a corpus is expected to contain entries the walk cannot read. |
| [`LINK_DEFERRED_ARTIFACT`](#link_deferred_artifact) | info | Link targets a deferred build artifact declared in the skill files: config; it will exist after the build materializes it. | No action needed if the files: entry is correct. To silence, set validation.severity.LINK_DEFERRED_ARTIFACT: ignore. |
| [`LINK_TO_SKILL_DEFINITION`](#link_to_skill_definition) | error | Markdown link targets another skill's SKILL.md; bundling it creates duplicate skill definitions. | Link to a specific resource inside the other skill, or reference the other skill by name. |
| [`LINK_FROM_NON_ROUTABLE_FILE`](#link_from_non_routable_file) | warning | A bundled non-routable file (HTML) links to a file the walker did not follow, so the target is not in the bundle and the packaged link points at nothing. | Link the target from a markdown file in the bundle, declare it under skills.config.<name>.files, or set severity.LINK_FROM_NON_ROUTABLE_FILE to ignore if the packaged link is meant to resolve outside the bundle. |
| [`LINK_DROPPED_BY_DEPTH`](#link_dropped_by_depth) | warning | Walker stopped following links at the configured linkFollowDepth; this link was not bundled. | Raise linkFollowDepth, bundle the file via files config, declare the drop intentional with validation.allow, or exclude via excludeReferencesFromBundle.rules. |
| [`LINK_EXCLUDED_BY_PATTERN`](#link_excluded_by_pattern) | info | A reference was excluded from the bundle by an excludeReferencesFromBundle rule this project declared; the target did not ship. | No action needed if the exclusion is intended — the rule did exactly what it was configured to do. If the target should have shipped, narrow or remove the matching excludeReferencesFromBundle rule, or declare the file under skills.config.<name>.files. Set severity.LINK_EXCLUDED_BY_PATTERN to ignore to drop these from the report entirely. |
| [`PACKAGED_UNREFERENCED_FILE`](#packaged_unreferenced_file) | error | File in the packaged output is not referenced from any packaged markdown. | Add a markdown link or code-block mention in SKILL.md or a linked resource. A file consumed programmatically belongs in skills.config.<name>.files as a source/dest pair — a declared dest is exempt, so do NOT restate it in validation.allow. |
| [`PACKAGED_AGENT_INSTRUCTION_FILE`](#packaged_agent_instruction_file) | warning | A repo-internal agent-instruction file (CLAUDE.md, AGENTS.md, GEMINI.md) is present in the scanned tree — a built skill bundle, an installed plugin, or a plugin source directory. | In a distributed tree (a built bundle or an installed plugin) remove the file, or move it outside the directory that is packaged. In a repo source tree, confirm first whether it ships: the build excludes agent-instruction files from the plugin tree-copy and from files: globs, so only an explicit files: entry naming it puts it in the output. If it must ship, set severity.PACKAGED_AGENT_INSTRUCTION_FILE to ignore so the exception is recorded in config. If an explicit files: entry already names this dest, vat build and vat verify honour it and stay silent; vat audit reports it anyway because a path-addressed scan cannot see the config that declared it. |
| [`TREE_PROVENANCE_INDETERMINATE`](#tree_provenance_indeterminate) | warning | Could not determine whether a scanned skill tree is repository source or a distributed artifact, because `git` could not be consulted; agent-instruction files present in the tree were left unclassified rather than silently accepted. | Make `git` runnable for this tree — install it, put it on PATH, or repair the repository whose `.git` directory could not be read — then re-run the audit. Set severity.TREE_PROVENANCE_INDETERMINATE to ignore if this environment deliberately has no git and the unclassified files are known to be repository source. |
| [`FILES_GLOB_DROPPED_NEVER_PACKAGED`](#files_glob_dropped_never_packaged) | warning | A `files:` glob matched a file that is never packaged into a skill bundle (an agent-instruction file such as CLAUDE.md, or a navigation file such as README.md); it was dropped and did not ship. | No action needed if the drop is intended — a glob is a net, not a declaration. To ship that specific file deliberately, add an explicit `files:` entry naming it (`source: <path>`); to stop matching it at all, narrow the glob. |
| [`FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED`](#files_glob_matched_only_never_packaged) | warning | A `files:` glob matched only files that are never packaged into a skill bundle (agent-instruction files such as CLAUDE.md, navigation files such as README.md), so the entry ships nothing and `vat skills build` fails on it. | Name the file you intend to ship in an explicit (non-glob) `files:` entry (`source: <path>`), or point the glob at a directory that holds files which can be packaged. Widening the glob does not help — the never-package filter matches on basename at any width. Set severity.FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED to ignore if the entry is deliberately inert. |
| [`FILES_GLOB_MATCHED_NOTHING`](#files_glob_matched_nothing) | info | A `files:` glob currently matches no files; `vat skills build` fails on a glob that matches nothing, so the build will fail unless that artifact is produced first. | No action needed if the glob points at a build artifact your project produces before `vat skills build` runs — matching nothing beforehand is expected. Otherwise correct the pattern (a `files:` source resolves relative to the project root) or drop the entry. Set severity.FILES_GLOB_MATCHED_NOTHING to ignore to silence it everywhere. |
| [`PACKAGED_TEST_INPUT`](#packaged_test_input) | warning | A link or files: entry pointed into the skill's declared test input (its test.evals path) and was NOT packaged; test input — including the expected_output answer key — never ships to consumers. | No action needed — the build already excluded it. Remove the link or files: entry to silence this, or move the target out of the test.evals directory if it is genuinely a shipped resource. |
| [`PACKAGED_BROKEN_LINK`](#packaged_broken_link) | error | Link in the packaged output resolves to a file that is not present in the output. | Report the issue — this indicates a VAT bug. As a temporary workaround, set severity.PACKAGED_BROKEN_LINK to ignore while the underlying bug is fixed. |

<!-- END:rule-catalog -->

### Disambiguation map (symptom × intent → code)

The same surface symptom (a "broken" link or an "orphan" file) means different
things depending on **intent**. This view names the broken⇄orphan oscillation
and shows the `files:` edge as the resolving state once `DeferredArtifacts` is wired.

| Symptom | Intent behind the file | Resolves to |
|---|---|---|
| Broken link | Build artifact declared in `files:` (not yet materialized) | `LINK_DEFERRED_ARTIFACT` (info — resolves after build) |
| Broken link | Typo / wrong path at source | `LINK_MISSING_TARGET` |
| Broken link | `files:` **dest** VAT declined to package (its source is declared test input) | `LINK_MISSING_TARGET` + a `PACKAGED_TEST_INPUT` receipt — never deferred, because nothing will materialize it |
| Broken link | Present at source, but the walk could not read it (permissions, or a change racing the walk) | `LINK_TARGET_UNREADABLE` (the file is there — this is not a missing target) |
| Broken link | Present in source but missing in **built** output | `PACKAGED_BROKEN_LINK` (link-rewriter bug — the issue's `fix` says to report it) |
| Broken link | Target a glob `files:` entry matched and the never-package filter dropped | `PACKAGED_BROKEN_LINK` (deliberate policy — same code, still blocking, but the issue's `fix` names this cause instead of blaming VAT) |
| Orphan file | Runtime asset loaded by a script | Declare in `files:` → no code (declaration is the resolution; the build's orphan check is given the dests it copied and exempts them) |
| Orphan file | Forgotten / undocumented doc | `PACKAGED_UNREFERENCED_FILE` (link it or remove it) |
| Orphan file | Copied by the packager, then orphaned by link rewriting | `PACKAGED_UNREFERENCED_FILE` + `PACKAGED_BROKEN_LINK` (a VAT inconsistency, not an author mistake) |
| Leaves the bundle | Links a file inside the skill's declared `test.evals` dir | `PACKAGED_TEST_INPUT` (warning — target not packaged, link rewritten away) |
| Leaves the bundle | Links a gitignored file | `LINK_TO_GITIGNORED_FILE` |
| Leaves the bundle | Links a gitignored file that IS a materialized `files:` build artifact | `LINK_DEFERRED_ARTIFACT` (info — expected post-build state, not a leak) |
| Leaves the bundle | Target outside the project root | `LINK_OUTSIDE_PROJECT` |
| Directory target | Navigational prose link | *valid at source — no code. The packaged output strips it to plain text: bundled resources are flattened into `resources/`, so no authored directory survives to point at.* |
| Directory target | Typed single-file slot (`files:` source) | `LINK_TARGETS_DIRECTORY` |

**Known limit (not faked):** an asset loaded by a packaged script but neither
linked nor declared in `files:` cannot be distinguished from a forgotten orphan
without parsing the script — VAT reports it as `PACKAGED_UNREFERENCED_FILE`; the
resolution is to declare it in `files:`. See the "Out of scope" section of issue #129.

## Source-Detectable Link Codes

*Stance: see [Structure](./skill-quality-and-compatibility.md#structure).*

Static-analysis codes that fire anywhere markdown is analyzed — `vat resources validate`, `vat skills validate`, `vat skills build`, `vat audit`.

### `LINK_OUTSIDE_PROJECT`

- **Default:** `error`
- **What:** Markdown link points to a file outside the project root.
- **Why it matters:** Skills and resource bundles are self-contained artifacts. A link that escapes the project root cannot be resolved by the agent at runtime and signals a structural problem in how the content is organized.
- **Fix:** Move the target inside the project or remove the link. Use `validation.allow` if the reference is intentional and cross-project.

### `LINK_TARGETS_DIRECTORY`

- **Default:** `error`
- **What:** A typed single-file reference (e.g. a `files:` source entry) resolves to a directory instead of a file.
- **Why it matters:** A single-file slot is opened or copied as exactly one file; a directory cannot satisfy that contract. Navigational prose links to a directory are valid and existence-checked — they do **not** trigger this code.
- **Fix:** Point the typed reference — a `files:` source, or any other single-file slot — at a specific file, not a directory.

> **Decision record D7 — directory index resolution (GitHub-style `docs/` → `docs/README.md`) is intentionally out of scope.** Because navigational prose links to a directory are now valid targets, there is no need to infer an index file; the directory link is simply allowed as-is. Implementing index resolution would add complexity for no benefit under the current model.

### `LINK_TO_UNBUNDLED_DIRECTORY`

- **Default:** `warning`
- **What:** A markdown link resolves to a directory. The link is valid where you wrote it — a reader browsing the repository follows it fine — but a directory is never packaged, so nothing at that path travels with the bundle.
- **Why it matters:** This used to be reported **nowhere**. The walker classified the link as `directory-target`, excluded the directory, and emitted no finding of any kind, so an author reading a clean report had no way to learn that the packaged prose now points at a path the bundle does not contain. The exclusion was correct; the silence about it was not.
- **Not [`LINK_TARGETS_DIRECTORY`](#link_targets_directory):** that code is for a **typed single-file slot** — a `files:` source entry that must resolve to one file — and it is an `error`. This one is for a navigational prose link, which D7 above deliberately keeps valid. Two different situations, two different remedies, two different severities; they never both fire for one reference.
- **Fix:** Link the specific file inside the directory that the prose means — a directory cannot be packaged, and VAT does not resolve one to an index file. Set `severity.LINK_TO_UNBUNDLED_DIRECTORY` to `ignore` if the link is meant for a reader browsing the repository rather than for the packaged bundle.

### `LINK_TO_NAVIGATION_FILE`

- **Default:** `warning`
- **What:** Markdown link targets a navigation file (`README.md`, `index.md`, etc.) which was excluded from the bundle.
- **Why it matters:** Navigation files are typically human-readable tables of contents excluded from skill bundles. Linking to one creates a dead reference inside the packaged output. Agents following the link at runtime find nothing useful.
- **Fix:** Link to the specific content instead of the navigation file, or set `severity.LINK_TO_NAVIGATION_FILE` to `ignore` if this is intentional.

### `LINK_TO_AGENT_INSTRUCTION_FILE`

- **Default:** `error`
- **What:** Markdown link targets a repo-internal agent-instruction file (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`) that **no explicit `files:` entry declares**. The walker does not bundle it, and the link is stripped from the packaged content — the shipped prose ends up pointing at nothing.
- **Why it matters:** These files are guidance *about the repository they live in*. Two harms, both observed on real corpora:
  1. **Silent mis-resolution.** Under `resourceNaming: basename`, two packages' `CLAUDE.md` files collide on a single destination. One wins, and every link to *either* source then resolves to the winner's content — the reader gets the wrong document with no error at read time.
  2. **Unintended instruction loading.** Claude Code loads `CLAUDE.md` files found in subdirectories under the working directory on demand, when it reads a file in that directory ([Claude Code memory docs](https://code.claude.com/docs/en/memory#how-claude-md-files-load)). A skill installed project-locally (`.claude/skills/<name>/`) sits under the working directory, so a bundled `CLAUDE.md` becomes live instructions the moment the agent opens a reference beside it. Skills installed outside the working directory (`~/.claude/skills`, plugin directories) are not exposed to this second harm; the first applies everywhere.

  `AGENTS.md` and `GEMINI.md` are not loaded as memory by Claude Code — it reads `CLAUDE.md`, and picks up an `AGENTS.md` only where a `CLAUDE.md` explicitly imports it (`@AGENTS.md`) or `/init` incorporates it. They are on the never-package list for the portability and collision reasons, and are treated identically to `CLAUDE.md`.

  <!-- @vendor-claim reviewed=2026-08-02 verify=Re-read https://code.claude.com/docs/en/memory — the "How CLAUDE.md files load" section for harm 2 (subdirectory CLAUDE.md files load on demand when Claude reads a file in that directory) and the "AGENTS.md" section for the AGENTS.md/GEMINI.md sentence. This claim is what the `error` default below rests on: if subdirectory CLAUDE.md files stop loading on demand, or AGENTS.md becomes a first-class memory file, re-argue the severity rather than reword the prose. -->

- **The cheapest correct fix is usually an absolute URL.** Most offending links point *upward* out of the skill directory (`../../packages/foo/CLAUDE.md`) at a file whose canonical home is a repository the reader can open. Replacing the relative path with the file's canonical URL keeps the reference, ships nothing, and clears the code — no config change at all. Distributed content that already links a `CLAUDE.md` this way is not flagged, because an absolute URL is not a local file reference.
- **Declaring the file is a real remedy, and it takes an EXPLICIT entry.** `source: docs/CLAUDE.md` in `skills.config.<name>.files` names the file; the walker honours that declaration, the file is bundled at the entry's `dest`, and this link is rewritten to point at it. A **glob** entry earns nothing here — a glob is a net, not a declaration, and the never-package filter drops these basenames out of its expansion (see [`FILES_GLOB_DROPPED_NEVER_PACKAGED`](#files_glob_dropped_never_packaged)). Weigh the declaration against the two harms above before reaching for it: for anything but a deliberately shipped template, one of the other three routes is better.
- **Fix:** Link the specific content the file describes; point the link at the file's canonical home as an absolute URL; or extract the shared part into a document intended for distribution. To ship the file deliberately, name it in an explicit (non-glob) `skills.config.<name>.files` entry — the file is then bundled and this link is rewritten to the declared dest.

### `LINK_TO_GITIGNORED_FILE`

- **Default:** `error`
- **What:** Markdown link targets a gitignored file; risks leaking ignored data into the bundle. Exempt when the target is declared under `skills.config.<name>.files` — a materialized, gitignored build artifact (e.g. a `dist/` output copied by a `files:` entry) is the expected post-build state, not a leak, and is downgraded to [`LINK_DEFERRED_ARTIFACT`](#link_deferred_artifact) instead.
- **Why it matters:** Gitignored files are typically excluded for a reason — generated artifacts, secrets, or local-only state. Bundling them could expose sensitive data or break portability for anyone cloning the repo. Building the project must not turn a passing `vat skills validate` run red on artifacts whose gitignored-ness is by design.
- **Fix:** Link to a non-ignored file or adjust `.gitignore`. Allow the specific path via `validation.allow` if the risk has been reviewed. If the target is a build artifact, declare it under `skills.config.<name>.files` instead.

### `LINK_MISSING_TARGET`

- **Default:** `error`
- **What:** Markdown link target does not exist on disk and is not a declared build artifact.
- **Why it matters:** Broken links in skill documentation mean agents hit dead ends when they follow references. This usually indicates a typo, a removed file, or a build-artifact path that needs declaring under `skills.config.<name>.files`.
- **Fix:** Fix the link path, create the file, or declare it under `skills.config.<name>.files` as a build artifact.

### `LINK_TARGET_UNREADABLE`

- **Default:** `error`
- **What:** Markdown link target exists on disk but could not be read, so it was neither classified nor bundled. Most often permissions; also a change racing the walk. The walk found the path (`existsSync` succeeded) and then could not `stat` it, so it could not tell what the target even is — file, directory, or anything else.
- **Not a missing target:** the distinction is the whole point of this code. [`LINK_MISSING_TARGET`](#link_missing_target) says *the path is not there*, and sends the author to fix a typo or create the file. This one says *the path is there and the tooling cannot read it*, which is an environment or permissions problem — following the missing-target remedy would have the author "create" a file that already exists.
- **Why it matters:** Before this code existed the link simply **vanished**: an unstattable target was skipped silently, producing no exclusion, no bundle entry and no finding, so the report described a corpus with one fewer edge in it than the one on disk. The same read failure has always been reported on the resources lane as [`RESOURCE_UNREADABLE`](#resource_unreadable) — this is that code's skill-packaging sibling, and the two lanes now agree about the same unreadable file.
- **Fix:** Fix the permissions on the target, or investigate what changed it mid-walk, then re-run. Set `severity.LINK_TARGET_UNREADABLE` to `warning` if a corpus is expected to contain entries the walk cannot read.

### `LINK_DEFERRED_ARTIFACT`

- **Default:** `info`
- **What:** Markdown link in `SKILL.md` targets a path declared as a build artifact under `skills.config.<name>.files`, in either of two states: (1) the path does not exist on disk yet — VAT downgrades the [`LINK_MISSING_TARGET`](#link_missing_target) finding (`vat skills validate`) or the [`LINK_BROKEN_FILE`](#link_broken_file) finding (`vat resources validate`) to this info notice, because the artifact has not been materialized yet at source time; or (2) the path exists and is gitignored — VAT downgrades the [`LINK_TO_GITIGNORED_FILE`](#link_to_gitignored_file) / [`LINK_TO_GITIGNORED`](#link_to_gitignored) finding instead, because a gitignored build artifact is the expected state *after* a build has run, not a leak. Both lanes compute the same deferred-artifact set (same skill discovery + `files:` config merge), so they never disagree about the same link.
- **Why it matters:** Deferred artifacts are intentional: the file is generated by a build step declared in the `files:` config, so a broken-link error (before the build) or a gitignored-leak error (after the build) would both be false positives. The info notice keeps the situation visible without blocking the build — critically, **building the project must not turn a passing validate/audit run red** on artifacts whose gitignored-ness is by design.
- **Fix:** No action needed if the `files:` entry is correct. To silence the notice, set `validation.severity.LINK_DEFERRED_ARTIFACT: ignore`.

### `LINK_TO_SKILL_DEFINITION`

- **Default:** `error`
- **What:** Markdown link targets another skill's `SKILL.md`; bundling it creates duplicate skill definitions.
- **Why it matters:** Each `SKILL.md` is a skill entry point. Including one skill's entry point inside another skill's bundle causes the agent framework to register the same skill twice, leading to unpredictable trigger behavior.
- **Fix:** Link to a specific resource inside the other skill, or reference the other skill by name.

### `LINK_BROKEN_FILE`

- **Default:** `error`
- **What:** A local file link points to a non-existent file.
- **Why it matters:** A broken local link is a dead reference — an agent or human following it lands on nothing. In a resources-path document this almost always means a typo, a renamed file, or a target that was deleted without updating the link. Fires in the `vat resources validate` path (the packaging-oriented equivalent is [`LINK_MISSING_TARGET`](#link_missing_target)). A missing target declared under `skills.config.<name>.files` is downgraded to [`LINK_DEFERRED_ARTIFACT`](#link_deferred_artifact) instead — `vat resources validate` reuses the same skill discovery and `files:` config merge as `vat skills validate`, so the two lanes agree on a given link's verdict. A target that exists but whose *Unicode normalization form* differs from the link's is deliberately not this code — it is the warning [`LINK_NORMALIZATION_MISMATCH`](#link_normalization_mismatch), because the file is really there and the link really opens on the author's machine.
- **Fix:** Fix the path or create the target file.

### `LINK_NORMALIZATION_MISMATCH`

- **Default:** `warning`
- **What:** A local file link resolves only after Unicode normalization. The link text and the filename on disk are the *same visible characters* stored in different normalization forms — precomposed NFC (`é` = `U+00E9`) versus decomposed NFD (`e` + `U+0301`). The two are different byte sequences, so they are different filenames to a byte-exact filesystem, but identical to a reader and to any tool that folds before comparing.
- **Why it matters:** This is the one link finding whose verdict depends on *which machine asks*. macOS/APFS and Windows reconcile the two forms at the syscall level, so the link opens on the author's machine, in their editor, and in a local preview — while on Linux/ext4 (CI, and most deploy targets) opening that exact spelling returns nothing at all. VAT reports it as a **warning rather than an error** for that reason: the file genuinely exists, the link genuinely works where it was written, and nothing about the target is missing. It is also why VAT does *not* report it as [`LINK_BROKEN_FILE`](#link_broken_file) — calling an existing accented file "not found" was a real false positive VAT used to emit, and folding both sides of the comparison fixed it; this code exists so that fix does not silently swallow the Linux-only breakage in the other direction. The message names both spellings with their non-ASCII characters escaped as code points, because printed literally the two are visually indistinguishable.
- **Fix:** Make the two spellings byte-identical. Prefer normalizing **both** sides to NFC — rename the file on disk to its NFC name and write the link in NFC — rather than rewriting the link to match an NFD name on disk: editors, browsers, and git checkouts routinely re-normalize typed text to NFC, so an NFD link is liable to be silently rewritten back and break again. Set `severity.LINK_NORMALIZATION_MISMATCH` to `ignore` if the corpus is only ever read on a normalization-insensitive filesystem.

### `LINK_BROKEN_ANCHOR`

- **Default:** `error`
- **What:** An anchor link (`file.md#section` or in-page `#section`) points to a heading or id that does not exist in the target.
- **Why it matters:** Anchor drift silently breaks deep-links. The file resolves, so the link looks valid, but the reader lands at the top of the document instead of the cited section — the worst kind of broken link because it is invisible until followed.
- **Fix:** Fix the fragment to match an existing heading slug, or fix the target heading.
- **Explicit ids count, not just heading slugs.** A markdown document that declares `<a id="short"></a>` (or a legacy `<a name="short">`, or an `id` on any raw-HTML element) contributes that id as a fragment target, exactly as GitHub does — so a short hand-written anchor above a long heading resolves instead of being reported broken. Only raw-HTML nodes are read: an `id=` shown inside a fenced block, an indented block, or a backticked span is being *documented*, not declared, and is never indexed. Markdown ids are matched case-insensitively (markdown's fragment policy is case-folded), which is marginally more permissive than a browser. This is unconditional for markdown — the `--check-html-anchors` opt-in governs `.html` *targets*, whose fragments are frequently defined at runtime by JS and so are not statically authoritative.

### `LINK_UNKNOWN`

- **Default:** `warning`
- **What:** A link could not be classified into any recognized link form (local file, anchor, external URL, mailto, etc.).
- **Why it matters:** An unclassifiable link usually indicates a malformed reference or an unsupported scheme. A warning (not an error) because the link engine cannot prove it is broken — only that it does not recognize the form. The markdown-link counterpart to the frontmatter [`frontmatter_unknown_link`](#frontmatter_unknown_link).
- **Fix:** Use a recognized link form.

### `LINK_TO_GITIGNORED`

- **Default:** `error`
- **What:** A tracked file links to a gitignored file. Exempt when the target is declared under `skills.config.<name>.files` — a materialized, gitignored build artifact is the expected post-build state, not a leak, and is downgraded to [`LINK_DEFERRED_ARTIFACT`](#link_deferred_artifact) instead.
- **Why it matters:** A committed document declaring a dependency on a gitignored target breaks portability — anyone cloning the repo gets the document but not the target. It also risks treating local-only or generated content as if it were part of the published artifact. Distinct from the skills-packaging code [`LINK_TO_GITIGNORED_FILE`](#link_to_gitignored_file), which guards against leaking ignored data into a *bundle*; this code fires in the `vat resources validate` path and the two coexist intentionally.
- **Fix:** Link a tracked target, or un-ignore the file in `.gitignore` if it should be committed. If the target is a build artifact, declare it under `skills.config.<name>.files` instead.

### `LINK_UNRESOLVED_REFERENCE`

- **Default:** `warning`
- **What:** A reference-style link (`[text][label]`, or the collapsed `[label][]` form) has no matching `[label]: url` definition anywhere in the document. Only the full and collapsed forms are detected; a bare shortcut reference (`[label]` alone, no second bracket pair) is an explicit non-goal — bracketed prose is ubiquitous in ordinary writing and would be a false-positive firehose. Detection is **single-line only**: a reference whose text or label spans a line break is not detected, since the raw-source scan works line by line.
- **Why it matters:** CommonMark resolves link references at *parse time*. Without a matching definition, the construct is never a link at all — it degrades to literal bracketed text, rendered verbatim to the reader. An AST-based checker is structurally blind to this: no `linkReference` node is ever produced for the dangling case, so nothing downstream of the parser can catch it without a dedicated raw-source scan. `warning`, not `error`, because the document still renders and the skill still functions — only the reference silently fails to become a link.
- **Fix:** Add the missing `[label]: url` definition, or rewrite as an inline link `[text](url)`.
- **Deliberately heuristic — tuned for precision:** `needle.get(url[, options][, callback])` and `the host application[3][4][8].` are *syntactically* full reference links; they render literally for exactly the same reason a typo does, so no CommonMark rule separates them from a genuine mistake. The detector therefore rejects occurrences whose label does not look like a label a human would define, and **trades recall for precision** — labels that are purely numeric (`[text][1]`), single-character (`matrix[i][j]`), punctuation-edged (`, options`), or alphanumeric-free are never reported, and neither is link text beginning with punctuation other than `!`. Code spans, fenced blocks, raw HTML (including HTML comments), YAML frontmatter, and the destination (url/title) of links, images, and definitions are masked out. Measured on a 1,822-document real-world markdown corpus (npm package READMEs plus this repo's own tracked markdown): **30 hits before tuning (5 genuine, 25 false) → 5 hits after (5 genuine, 0 false) on that corpus.** This is a property of the corpus, not a general guarantee — an unbackticked multi-char bracket subscript in prose (`config[section][option]`, `Dict[str][int]`) still satisfies every plausibility heuristic and will still be reported. Implementation and per-heuristic rationale: `packages/resources/src/unresolved-references.ts`.

## HTML Well-Formedness Codes

Unlike the link codes above, this code is HTML-specific and is **not** a link code. It fires only in the `vat resources validate` path — emitted by `ResourceRegistry` while parsing `.html`/`.htm` resources — and does not run under `vat skills validate`, `vat skills build`, or `vat audit`.

### `MALFORMED_HTML`

- **Default:** `info`
- **What:** An HTML resource has well-formedness problems (unclosed tags, stray characters, misnested elements) reported by the HTML parser.
- **Why it matters:** Malformed markup parses unpredictably across browsers and tools, and can hide or mangle the links VAT extracts. Surfaced as `info` because browsers are lenient and most pages still render.
- **Fix:** Fix the markup the parser flags. Raise severity via `validation.severity.MALFORMED_HTML` to enforce well-formedness.

## Frontmatter Link Codes

Validation codes that fire when a collection's frontmatter schema declares a URI-family `format` (`uri-reference`, `uri`, `iri-reference`, `iri`) on a field and `vat resources validate` walks those values through the same engine as markdown link checking. Disabled per-collection via `validation.checkFrontmatterLinks: false` or globally via `vat resources validate --no-check-frontmatter-links`. See [Frontmatter link validation](./guides/collection-validation.md#frontmatter-link-validation).

### `FRONTMATTER_MISSING`

- **Default:** `error`
- **What:** A collection's schema requires frontmatter but the file has none.
- **Why it matters:** When a collection's frontmatter schema declares required fields, a file with no frontmatter block cannot satisfy the contract. The absence is almost always an authoring oversight — the file was added to a schema-governed collection without the metadata the collection expects.
- **Fix:** Add the required frontmatter block to the file, or move the file out of the schema-governed collection if it is not meant to carry metadata.

### `FRONTMATTER_INVALID_YAML`

- **Default:** `error`
- **What:** The file's frontmatter block failed to parse as YAML.
- **Why it matters:** A frontmatter block that does not parse cannot be validated or consumed downstream. The metadata is effectively lost, and tooling that depends on it (collection schema validation, link checking, indexing) silently sees an empty document.
- **Fix:** Fix the YAML syntax in the frontmatter block (indentation, quoting, unescaped special characters).

### `FRONTMATTER_SCHEMA_ERROR`

- **Default:** `error`
- **What:** The file's frontmatter parsed as YAML but failed JSON Schema validation for its collection.
- **Why it matters:** A schema validation failure means the metadata violates the contract the collection declares — a missing required field, a wrong type, or a disallowed extra field under `strict` mode. Downstream consumers relying on the schema's guarantees will misbehave.
- **Fix:** Make the frontmatter conform to the collection's schema — add missing required fields, correct field types, or remove disallowed fields.

### `FRONTMATTER_LINK_BROKEN`

- **Default:** `error`
- **What:** A frontmatter value at a JSON Schema position with a URI-family `format` resolves to a relative path that does not exist on disk.
- **Why it matters:** The schema author's explicit `format: "uri-reference"` declaration is a contract that this field points at a real artifact. A broken value silently passes AJV validation today and only surfaces when an agent or human follows the link.
- **Fix:** Correct the path, create the target, or remove the field. The `frontmatter_link_broken` markdown-link equivalent is [`LINK_MISSING_TARGET`](#link_missing_target).

### `FRONTMATTER_ANCHOR_MISSING`

- **Default:** `error`
- **What:** A frontmatter URI-reference value contains `#anchor` and the anchor does not match any heading slug in the target file.
- **Why it matters:** Anchor drift silently breaks deep-links from frontmatter (e.g., `adr_citations[0].adr: docs/adr/0007.md#decision`). Agents and humans following the reference land at the top of the file instead of the cited section.
- **Fix:** Update the anchor to match a heading slug in the target, or drop the `#anchor` portion if no specific section is meant.

### `FRONTMATTER_LINK_TO_GITIGNORED`

- **Default:** `error`
- **What:** A non-gitignored file references a gitignored target via a URI-reference frontmatter field.
- **Why it matters:** Same risk as the markdown-link equivalent: a committed file claims a dependency on a target that isn't tracked, breaking portability for anyone cloning the repo and risking exposure of locally-only content.
- **Fix:** Reference a non-ignored file, or adjust `.gitignore`. The markdown-link equivalent is [`LINK_TO_GITIGNORED_FILE`](#link_to_gitignored_file).

### `FRONTMATTER_UNKNOWN_LINK`

- **Default:** `warning`
- **What:** A frontmatter URI reference could not be classified — it uses an unknown URI scheme (e.g., `tel:`, `javascript:`, `git+ssh:`) or a form the link engine does not recognize.
- **Why it matters:** URI-family fields are expected to be `http(s)://`, `mailto:`, or local path references. Unknown schemes typically indicate a typo, a paste error, or a deliberately unsupported protocol that won't resolve at runtime. A warning (not an error) because an unclassifiable reference is a signal to review, not a guaranteed breakage. Distinct from the markdown-link [`LINK_UNKNOWN`](#link_unknown) so severity can be configured per surface.
- **Fix:** Use a recognized reference form — correct the value to a supported scheme, or add a `pattern` constraint to the field if a specific allow-list is required.

## External URL Codes

Codes that fire when `vat resources validate` checks external `http(s)://` links by issuing network requests. Network checks are opt-in and best-effort — all three default to `warning` because a failed request may reflect a transient outage, a rate limit, or a network condition on the validating machine rather than a genuinely broken link. Set the relevant `severity` to `ignore` to disable a class, or use `validation.allow` to suppress specific URLs.

### `EXTERNAL_URL_DEAD`

- **Default:** `warning`
- **What:** An external URL returned an error status (4xx/5xx).
- **Why it matters:** A 4xx/5xx response usually means the linked resource moved, was removed, or requires auth the validator does not have. Readers following the link hit an error page. A warning rather than an error because the status may be transient (a 503) or environment-specific (a 403 behind a corporate proxy).
- **Fix:** Fix or remove the link; or set `severity.EXTERNAL_URL_DEAD` to `ignore` if the endpoint is expected to be unreachable from validation.

### `EXTERNAL_URL_TIMEOUT`

- **Default:** `warning`
- **What:** An external URL request timed out before a response arrived.
- **Why it matters:** A timeout may mean the host is slow, the link is dead, or the validating machine's network is constrained. The ambiguity is why this is a warning — a timeout is not proof the link is broken.
- **Fix:** Retry; raise the request timeout; or set `severity.EXTERNAL_URL_TIMEOUT` to `ignore` for known-slow hosts.

### `EXTERNAL_URL_ERROR`

- **Default:** `warning`
- **What:** An external URL request failed at the network level (DNS resolution failure, connection refused, TLS error).
- **Why it matters:** A network-level failure often reflects a transient DNS or connectivity problem on the validating machine rather than a genuinely broken link, so it is surfaced as a warning rather than blocking the build.
- **Fix:** Check the host (DNS, reachability, certificate); or set `severity.EXTERNAL_URL_ERROR` to `ignore` if the host is intentionally unreachable from the validation environment.

## Authenticated External Link Codes

Codes that fire when `vat resources validate` checks external links whose host is claimed by a provider in `resources.linkAuth` (e.g. private GitHub repos, SharePoint files). The validator issues an authenticated request via the configured token source and classifies the response; outcome-to-code mapping is per-provider because hosts disagree about what a 404 means (GitHub masks `403 access-denied` as `404`; Microsoft Graph distinguishes cleanly). All five codes are configurable like any other code (`validation.severity` / `validation.allow`); the provider's `check` block routes an outcome to a *code*, never to a *severity*.

### `LINK_AUTH_DEAD`

- **Default:** `error`
- **What:** An authenticated external link returned `404` or `410` from a host whose provider declares `notFoundMeaning: dead` (i.e. honest-404 hosts like SharePoint). The request was authenticated, so `404` here is not a permissions problem — the resource is missing.
- **Why it matters:** Unlike the anonymous external-URL check, an authenticated 404 against an honest-404 host is high-confidence evidence of link rot, which is why this is the only `LINK_AUTH_*` code that defaults to `error`. The provider declares this property; hosts that mask access-denied as 404 instead use [`LINK_AUTH_DEAD_OR_UNAUTHORIZED`](#link_auth_dead_or_unauthorized).
- **Fix:** Fix or remove the link; or set `severity.LINK_AUTH_DEAD` to `ignore` if the path is expected to be transient.

### `LINK_AUTH_DEAD_OR_UNAUTHORIZED`

- **Default:** `warning`
- **What:** An authenticated external link returned `404` from a host whose provider declares `notFoundMeaning: ambiguous` (i.e. hosts that mask `403 access-denied` as `404`, like GitHub). The link is either rotted *or* inaccessible to the current identity — the response alone cannot distinguish.
- **Why it matters:** GitHub deliberately does not leak existence of private resources via `403`; both "the file doesn't exist" and "you don't have permission to see this file" return `404`. The checker cannot prove rot, so this is a warning rather than an error. Contributors on a repo where some links point at resources they lack access to will see warnings, not red builds.
- **Fix:** Verify the URL by hand (or with a more-privileged token) to disambiguate; fix or remove if rotted; or set `severity.LINK_AUTH_DEAD_OR_UNAUTHORIZED` to `ignore` if cross-identity ambiguity is expected.

### `LINK_AUTH_FORBIDDEN`

- **Default:** `warning`
- **What:** An authenticated external link returned `403`: the configured identity is authenticated, but the resource refuses access. (Only fires for hosts that emit honest `403`s — see `LINK_AUTH_DEAD_OR_UNAUTHORIZED` for hosts that mask access-denied as `404`.)
- **Why it matters:** A `403` is a permissions signal, not link rot. Treating it as an error would block builds whenever a contributor lacks access to some linked resource — common on cross-team docs. The remedy is granting access or switching identity, not editing the link.
- **Fix:** Grant the identity access to the resource; switch to an identity that has access; or set `severity.LINK_AUTH_FORBIDDEN` to `ignore` if cross-identity inaccessibility is expected.

### `LINK_AUTH_UNAUTHORIZED`

- **Default:** `warning`
- **What:** An authenticated external link returned `401`: the token sent with the request was missing, expired, or invalid for the resource's auth scheme.
- **Why it matters:** Usually a configuration or session problem — the token source resolved a value, but the host rejected it. The link itself may be perfectly fine. Strict CI lanes that should fail on stale credentials can promote this to `error`.
- **Fix:** Refresh the token (e.g. `gh auth login`, `az login`); check the `token` config in `resources.linkAuth`; or promote `severity.LINK_AUTH_UNAUTHORIZED` to `error` on strict CI lanes.

### `LINK_AUTH_UNVERIFIED`

- **Default:** `warning`
- **What:** A provider in `resources.linkAuth` claims this host, but no token source resolved — none of the configured env vars or argv commands produced a non-empty value, so no authenticated request was attempted.
- **Why it matters:** External-URL checking is opt-in, so silently skipping links the project asked to check would be misleading. But `unverified` is not link rot — the link may be fine; the validator just couldn't authenticate. The fix is configuration, not link editing. (`unverified` outcomes are never cached, because the result flips the moment a token appears.)
- **Fix:** Configure a `token` source (env var or argv command); log in to the underlying CLI (e.g. `gh auth login`, `az login`); or set `severity.LINK_AUTH_UNVERIFIED` to `ignore` if running without auth is intentional.

## Packaging-Only Codes

*Stance: see [Packaging](./skill-quality-and-compatibility.md#packaging).*

Only meaningful when a skill is actually being bundled. Most fire from `vat skills build` (and its pre-flight in `vat skills validate`), but not all of them do — a few belong to the post-build and scan lanes instead (`vat verify`, `vat audit`, `vat claude plugin build`). **Each code's own section names the verbs that emit it; read that rather than assuming this heading.**

### `LINK_FROM_NON_ROUTABLE_FILE`

- **Default:** `warning`
- **What:** A bundled **non-routable** file — currently HTML — links to a file the walker did not follow, so the target is not in the bundle and the packaged link points at nothing.
- **Membership vs. routability:** VAT parses HTML, so a bundled `.html` page *is* a registry member: its links are known and the packager rewrites them to point at bundled copies. It is not **routable** — VAT does not walk *through* it to pull its link targets into the bundle. HTML is a leaf you can read, not a door you walk through. Routing is markdown-only, matching Anthropic's skill guidance.
- **Why it matters:** `SKILL.md → guide.html → diagram.svg` bundles `guide.html` and drops `diagram.svg`. Because the referring page *did* ship, the missing image reads as a link-rewriter bug rather than a routing boundary, and before this code existed the drop was entirely silent.
- **Fix:** Link the target from a markdown file in the bundle, declare it under `skills.config.<name>.files`, or set `severity.LINK_FROM_NON_ROUTABLE_FILE` to ignore if the packaged link is meant to resolve outside the bundle.
- **Not this code:** if the HTML page's link target does not exist on disk at all, that is an author's broken link and reports as [`LINK_MISSING_TARGET`](#link_missing_target). This code fires only for a target that exists and simply had no markdown referrer.

### `LINK_DROPPED_BY_DEPTH`

- **Default:** `warning`
- **What:** Walker stopped following links at the configured `linkFollowDepth`; this link was not bundled.
- **Why it matters:** A depth-limited walk may silently omit content the skill author expected to be included. The agent gets a partial bundle without knowing it.
- **Fix:** Raise `linkFollowDepth`, bundle the file via `files` config, declare the drop intentional with `validation.allow`, or exclude via `excludeReferencesFromBundle.rules`.

### `LINK_EXCLUDED_BY_PATTERN`

- **Default:** `info`
- **What:** A reference matched one of this project's own `excludeReferencesFromBundle` rules, so the walker did not bundle its target.
- **Why it matters:** Nothing is wrong — you configured this. What was wrong is that the build said **nothing at all**, which made "why did this file not ship?" unanswerable from the report by the one component that knew the answer. The message names the patterns of the rule that matched, so with several rules configured you learn *which* one refused the reference rather than only that something did.
- **Why `info` and not `warning`:** every rule fires on every build by design, so a louder severity would put permanent noise on a correct configuration and train readers to skip the report. `info` keeps the receipt available to anyone looking and out of the way of anyone who is not — the same posture as [`LINK_DEFERRED_ARTIFACT`](#link_deferred_artifact).
- **Compare [`LINK_DROPPED_BY_DEPTH`](#link_dropped_by_depth)** (a `warning`): that reports a drop caused by a *number* the author may not have meant to bind; this reports a drop caused by a *pattern* they wrote for exactly this file.
- **Fix:** No action needed if the exclusion is intended — the rule did exactly what it was configured to do. If the target should have shipped, narrow or remove the matching `excludeReferencesFromBundle` rule, or declare the file under `skills.config.<name>.files`. Set `severity.LINK_EXCLUDED_BY_PATTERN` to `ignore` to drop these from the report entirely.

### `PACKAGED_UNREFERENCED_FILE`

- **Default:** `error`
- **What:** File in the packaged output is not referenced from any packaged markdown **and** not declared as a `files:` dest.
- **Why it matters:** An orphan in the bundle is content an agent can never discover. The population left after the three exemptions below is narrow and real: a file the packager *itself* copied and then orphaned — the link rewriter left the referring href pointing somewhere else — which is why it stays an `error` and normally arrives paired with a [`PACKAGED_BROKEN_LINK`](#packaged_broken_link).
- **Three peer ways to not be an orphan:** reachable by a markdown link from `SKILL.md`; mentioned by path anywhere in packaged content (a code-block invocation is documentation); or **declared under `skills.config.<name>.files` as a `source`/`dest` pair**. Declaration is proof of intent on equal footing with documentation — you cannot forget a file you named twice in config — so a `files:` dest never fires this code, glob-expanded dests included.
- **Fix:** Add a markdown link or code-block mention in `SKILL.md` or a linked resource. A file consumed programmatically — a vendored engine, a generated schema, a data pack — belongs in `skills.config.<name>.files`; a declared dest is already exempt, so **do not restate it in `validation.allow`**. A hand-maintained waiver list that duplicates the `files:` map is a symptom, not a fix.

### `PACKAGED_AGENT_INSTRUCTION_FILE`

- **Default:** `warning`
- **What:** A repo-internal agent-instruction file (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`) is **present in the tree being scanned** — a packaged skill directory, an installed plugin, or a plugin source directory.
- **Why it matters:** [`LINK_TO_AGENT_INSTRUCTION_FILE`](#link_to_agent_instruction_file) covers the *reference* and keeps the file out of the bundle. It cannot cover the other routes in, and a published bundle carrying your repo's internal instructions is harmless to run but leaks how your team works. This detector reads the scanned tree directly, so it is blind to *how* the file arrived — which is the point: it is the backstop that does not need to enumerate the routes.
- **Read it against the lane that emitted it — SOURCE and DIST are different claims.** The detector runs over whichever tree it is handed, and two lanes hand it different things:
  - **Distributed trees** — a built skill bundle (`vat verify`'s `packaged-content` phase and `vat audit <bundle>`) or an **installed** third-party plugin under `~/.claude/plugins` (`vat audit`). Here the file demonstrably shipped: it is sitting in the artifact. This is the dominant audited population, and it usually has no VAT config and no `files:` entry at all — nothing was "declared", the file simply travelled with someone's publish.
  - **A plugin `source:` directory in your own repo** (`vat audit`, before a build). Here the finding is an observation about the *source*, not a prediction about what ships: `vat build` excludes agent-instruction files from the plugin tree-copy and from `files:` **globs** (see [never-packaged files](./guides/skill-files-and-routing.md#never-packaged-files-globs-only)), so the file does **not** reach the built tree by either route. Only an **explicit** `files:` entry naming it (`source: docs/CLAUDE.md`) still ships it, and naming it is the instruction to do so. Do not delete a useful repo-internal doc to satisfy this warning — check the built output first (`vat verify`), and if the file is not there, the source-side finding is informational.
- **Which verbs actually emit it — measured, not inferred.** `vat audit` and `vat verify` are the two live producers.
  - `vat validate` emits **none of these**. Its surfaces are resources and skills; neither walks a plugin `source:` tree. Measured 2026-08-02 against a fixture whose plugin `source:` directory held three agent-instruction files: `vat audit .` reported 3 × `PACKAGED_AGENT_INSTRUCTION_FILE`, while `vat validate` returned `status: success` with 0 errors / 0 warnings / 0 info. If you want this class of finding before a build, run `vat audit`.
  - `vat skills build` runs the same detector over each bundle it writes, but **no configuration is currently known to reach it**: every route into a skill bundle is closed upstream. Link traversal refuses these basenames unless an explicit `files:` entry declares them (and a declared dest is then exempt here by design); a `files:` **glob** drops them as never-packaged; the plugin tree-copy excludes them; and a `CLAUDE.md` merely sitting beside a `SKILL.md` is never copied at all. The call stays in place as a backstop against a future route, so a finding from the build lane is a real one — just do not expect the build to be the lane that first tells you.
- **An explicit `files:` entry suppresses this finding wherever the config is knowable.** Naming a `source`/`dest` pair is an unambiguous instruction to ship that exact file, so `vat skills build` and `vat verify` do not report the dest at all — reporting it fired this warning on precisely the config documented as the escape hatch, with a remedy ("remove the file") that told the author to undo what config had sanctioned. A **glob** match never earns the suppression, for the same reason it never earns the exemption: a glob is a net, not a declaration. `vat audit <path>` still reports it, because that lane resolves a subject by PATH and a built bundle's path is not its source skill's declared path — there is no config block it can read intent from. If audit alone flags a dest you declared, check `vat verify`: silence there is the authoritative answer.
- **Which trees `vat audit` crawls, and which it leaves alone.** Audit crawls a skill directory only when it is a **distributed tree**, decided from where the `SKILL.md` actually lives:
  - **Inside a Claude install root** (`plugins/`, `skills/`, `marketplaces/` under `$CLAUDE_CONFIG_DIR` or `~/.claude`) — an installed skill or plugin. This clause outranks the git one below, because Claude Code installs marketplaces by `git clone`: an installed tree's files are *tracked source*, of somebody else's repository, and for a git-distributed plugin tracked source is exactly what ships.

    <!-- @vendor-claim reviewed=2026-08-02 verify=Install a marketplace with /plugin marketplace add and confirm the tree under ~/.claude/plugins/marketplaces/<name> is a git working copy (has .git, `git -C <dir> status` succeeds, plugin files are tracked). If Claude Code stops cloning — e.g. switches to tarball extraction — the install-root clause no longer needs to outrank the git test and this ordering should be revisited. -->

  - **Otherwise, when the `SKILL.md` is not git-visible source** — it is gitignored (a built `dist/` bundle) or lies outside any git repository (an unpacked tarball, a third-party bundle).

  Everything else is repository source and is deliberately never flagged: a skill that is tracked, **or untracked-but-not-ignored** (written and not yet committed — authoring in progress is not a distribution artifact). This is not a `dist/` path heuristic; there is none.

  It is also **not** the project's config. "The project does not declare this skill" was the original discriminator and it was wrong in both of the ways a repository can fail to declare one: a repo that has not adopted VAT has no config at all, and an adopting repo's `include` globs never enumerate its drafts, vendored copies and fixtures. Both are ordinary source, and `vat audit` on a fresh repo — the first command a new user runs — greeted them with a warning about guidance that ships nowhere. The config does not gate whether the question is *asked*, either: a skill the project declares is classified exactly like one it does not, so adding a `vibe-agent-toolkit.config.yaml` to a dotfiles repo does not remove findings from skills installed under `~/.claude`.

  When the tree is inside a git repository but git cannot be consulted at all — no `git` on `PATH`, or a corrupt or unreadable `.git` — no classification is possible and the run says so via [`TREE_PROVENANCE_INDETERMINATE`](#tree_provenance_indeterminate) rather than defaulting to silence.

  Inside a plugin, the plugin-wide crawl owns the whole subtree, so a nested skill's file is reported once, not twice. The plugin lane is independent of the classification above, which is why a **plugin `source:` directory in your own repo** still reports (see the bullet above for how to read that finding).
- **Why this is a `warning`, not an `error`:** unlike the link case, nothing mis-resolves and nothing is broken — the bundle works. Per [validation rule design](./validation-rule-design.md#default-severity-posture), `error` is reserved for a skill that cannot function as written. This is a hygiene observation, so it reports and does not block. There is also a real legitimate case: a plugin that **scaffolds** a repository ships a `CLAUDE.md` *template* on purpose (Anthropic's own `dataverse` plugin does this at `templates/CLAUDE.md`, placeholders and all). VAT does not try to tell a scaffold from a stray file by directory name — a `templates/` heuristic would be wrong in both directions — so the intentional case declares itself via the severity override below.

  <!-- @vendor-claim reviewed=2026-08-02 verify=Confirm the scaffold-template case still exists in the wild: install the official Anthropic marketplace and check that dataverse still ships templates/CLAUDE.md (placeholders and all). If no reviewed plugin ships a deliberate template any more, the "legitimate case" argument for keeping this a warning has lost its example and the severity should be re-argued, not just reworded. -->

- **Observed rate (an observation, not a constant):** `vat audit --user` on one real install reported **7 distinct agent-instruction files across 628 audited skills** (~1%), of which 1 was the intentional scaffold above. First measured 2026-08-01 and re-measured unchanged 2026-08-02. Low enough to be a signal rather than noise, which is why it ships on by default rather than behind a flag. Re-measure before citing this rate as evidence for a severity change — it describes one machine's plugin set on those dates, not the ecosystem.
- **Fix:** In a distributed tree (a built bundle or an installed plugin), remove the file or move it outside the packaged directory — repo-root `CLAUDE.md` files are never in a plugin `source:` dir and never trigger this. In a repo source tree, first confirm whether it actually ships: the build already excludes it unless an explicit `files:` entry names it, and if it does not ship there is nothing to delete. If it must ship — a scaffolding template is the legitimate case — set `severity.PACKAGED_AGENT_INSTRUCTION_FILE` to `ignore` so the exception is recorded in config rather than carried in your head.

### `TREE_PROVENANCE_INDETERMINATE`

- **Default:** `warning`
- **What:** `vat audit` could not decide whether a scanned skill tree is repository source or a distributed artifact, because `git` could not be consulted — no `git` on `PATH`, or a `.git` directory that is corrupt or unreadable. Agent-instruction files found in the tree were left unclassified instead of being silently accepted.
- **Why it matters:** [`PACKAGED_AGENT_INSTRUCTION_FILE`](#packaged_agent_instruction_file)'s audit lane only reports files in a **distributed** tree, and everything that is not an install root is decided from git. Every git failure returns the same "I don't know", which used to collapse into "not ignored" ⇒ source ⇒ silence: the detector switched itself off, the run still said `status: success`, and nothing anywhere said why. One finding became zero without a trace. That direction is unacceptable for a detector about what left your repository, so the missing answer is now reported as a missing answer.
- **Why not just assume "distributed"?** Because that manufactures a claim about the artifact — *this file shipped to consumers* — that nothing observed, and its remediation ("remove the file") is wrong advice for the ordinary source tree in a container that happens to have no git. This code makes a claim only about the tool's own capability, which is the part actually observed.
- **When it is emitted:** once per scanned skill tree, and only when the tree actually contains agent-instruction files. With none present nothing was left unclassified, and healthy git would have produced silence too — so a clean repository in a git-less environment stays quiet.
- **Why this is a `warning`, not an `info`:** it stands in for a `warning`, and a CI gate that counts warnings must not be zeroable by breaking git.
- **Fix:** Make `git` runnable for this tree — install it, put it on `PATH`, or repair the repository whose `.git` directory could not be read — then re-run the audit. Set `severity.TREE_PROVENANCE_INDETERMINATE` to `ignore` if this environment deliberately has no git and the unclassified files are known to be repository source.

### `FILES_GLOB_DROPPED_NEVER_PACKAGED`

- **Default:** `warning`
- **What:** A **glob** `files:` entry matched a file VAT never packages into a skill bundle — an agent-instruction file (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`) or a navigation file (`README.md`, `index.md`) — so the file was dropped and did not ship. One finding per dropped file.
- **Why it matters:** A glob is a net, not a declaration: it never named the file it caught, so it does not get to launder the exemption an explicit declaration earns (see [never-packaged files](./guides/skill-files-and-routing.md#never-packaged-files-globs-only)). But a file silently vanishing between "the config matched it" and "the bundle shipped" is exactly the class of thing a build must say out loud — otherwise the machine-readable report says `warnings: 0` for a build that shipped less than the config asked for, and an author who expected their glob to carry a `README.md` has no thread to pull. This code is that receipt.
- **Reported before a build, not only during one.** `vat skills validate` and `vat audit` expand the same globs the packager expands — the same code path, so the two lanes cannot disagree about what ships — and report the same drops without writing anything. This code covers the case where the entry still ships *something*. The two ways an entry can end up shipping nothing are separate findings with their own severities, because they have separate causes and separate remedies: [`FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED`](#files_glob_matched_only_never_packaged) (`warning` — it matched, and every match was refused) and [`FILES_GLOB_MATCHED_NOTHING`](#files_glob_matched_nothing) (`info` — it matched nothing, and the artifact may simply not have been built yet). At copy time both are hard errors, with distinct messages, because the build has run and both states are then real.
- **Where it points:** the **source file** that was refused, project-relative — the one path in this finding you can actually open. The would-be `dest` is deliberately not used as the location: nothing was written there, so it names a path that exists in no tree, and putting it in a `location` field made one issue list speak two coordinate systems at once. The glob pattern is still in the message, because it answers the second question: which entry caught this?
- **Why this is a `warning`, not an `error`:** the build produced the correct artifact and needs no edit — the drop is policy working as designed. It is louder than `info` because the delta between "what I declared" and "what shipped" is something an author should see once and then either accept or act on.
- **Related:** if a packaged document *links* the dropped file, that link now resolves to nothing and is reported as [`PACKAGED_BROKEN_LINK`](#packaged_broken_link) with a remediation naming this cause specifically — the build fails, correctly, because the shipped bundle has a dead link.
- **Fix:** None required if the drop is intended. To ship that specific file deliberately, add an explicit `files:` entry naming it (`source: <path>`); to stop matching it at all, narrow the glob.

### `FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED`

- **Default:** `warning`
- **What:** A **glob** `files:` entry matched files, and the never-package list refused **every** one of them — so the entry ships nothing at all. One finding per entry, naming the pattern and every refused file. Reported by the pre-build gates (`vat skills validate`, `vat audit`).
- **Why it matters:** `vat skills build` has a *second*, distinct hard error for this case — *"matched N file(s) … but all of them are never packaged"* — deliberately **not** "has your build run?", because here the build has run and the directory is populated. The pre-build gates emitted only the per-file [drops](#files_glob_dropped_never_packaged) for such an entry: the harmless half of the finding (a glob is a net) with nothing said about the entry being fatal. That is the same silence the [zero-match code](#files_glob_matched_nothing) closes, wearing different clothes.
- **One finding per entry, and it replaces the per-file drops.** The build raises one error listing every refused file rather than N receipts, and this mirrors it: reporting both would name a single defect twice, at two granularities. The refused file names are in this issue's message, in the same source coordinates the drop findings use.
- **The escape hatch does not rescue this entry.** An explicit `files:` entry naming one of the refused files ships *that file* — but the glob entry's own surviving set is still empty, so `vat skills build` still fails on it. This finding is therefore **not** filtered by what other entries ship; filtering it would predict a green build that fails.
- **Why this is a `warning`, not an `error`:** a pre-build tree can be a *partial* artifact as easily as an absent one — a stale `dist/` holding only a `README.md` is the same phenomenon that makes the zero-match `info` — so blocking CI here can be wrong. It is louder than `info` because, unlike an empty directory, a directory containing **only** never-packaged files is not the ordinary pre-build state.
- **Where it points:** the glob's **static base** — the directory the pattern expands under, project-relative. The finding is about the entry, not about any one file.
- **Fix:** Name the file you intend to ship in an explicit (non-glob) `files:` entry (`source: <path>`), or point the glob at a directory that holds files which can be packaged. **Widening the glob does not help** — the never-package filter matches on *basename* and applies at any width, so a wider pattern clears the error while still shipping none of these files. Set `severity.FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED` to `ignore` if the entry is deliberately inert.

### `FILES_GLOB_MATCHED_NOTHING`

- **Default:** `info`
- **What:** A **glob** `files:` entry currently expands to zero files. One finding per entry, reported by the pre-build gates only (`vat skills validate`, `vat audit`) — naming the pattern and the directory it expands under.
- **Why it matters:** `vat skills build` treats a glob that matches nothing as a hard error (*"files: source '…' (glob) matched no files under … — has your build run?"*). The pre-build gates are what adopters and their CI run *before* that build, and on this exact input they used to report `success` with zero findings — while dutifully reporting the never-package [drop](#files_glob_dropped_never_packaged), which is harmless by design. The gate reported the harmless case and stayed silent about the fatal one. This code ends that asymmetry.
- **Why this is `info`, not an error or a warning:** matching nothing *before* the artifact exists is the expected state, not a defect — a glob over an unbuilt `dist/` is exactly what a pre-build gate should see, and failing CI for it would make the gate unusable in the ordinary lifecycle. `info` keeps that judgement and still tells you the next command will fail. If your pipeline builds the artifact before `vat skills build` runs, this finding is pure information; if it does not, it is the earliest warning you can get.
- **Not the same as "everything it matched was dropped."** A glob that matched files and had every match refused by the never-package list has *matched*: that is [`FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED`](#files_glob_matched_only_never_packaged), a `warning` with a different remedy — "produce the artifact first" is useless advice for a directory that is already populated. Only a genuinely empty expansion reaches this code. The three verdicts (partial drop / nothing shippable / nothing matched) are mutually exclusive per entry, so one entry never gets two findings naming two causes.
- **Where it points:** the glob's **static base** — the directory the pattern expands under, project-relative. There is no file to open: that is the finding.
- **Fix:** None required if the pattern points at a build artifact your project produces before `vat skills build` runs. Otherwise the pattern is wrong: check it against the project root (a `files:` source resolves relative to the project root, not to the skill directory), correct it, or drop the entry. Set `severity.FILES_GLOB_MATCHED_NOTHING` to `ignore` to silence it everywhere.

### `PACKAGED_TEST_INPUT`

- **Default:** `warning`
- **What:** A **link** (from `SKILL.md` or any bundled resource) or a **`files:` entry** pointed into the skill's declared test input (`skills.config.<name>.test.evals`) and its target was **not** packaged. One receipt per dropped target, from every lane that models the bundle — `vat skills validate`, `vat skills build`, and the plugin build all emit it for the same target at the same location.
- **Why it matters:** An eval suite holds the `expected_output` / `expectations` **answer key** for the tasks the skill is graded on. Shipping it harms twice: plugin consumers download test input they have no use for, and — because `vat skill test` stages the built artifact — an executor under test can read its own answer key and grade as a PASS while demonstrating nothing. That failure is silent and it makes evals pass *more*, so it improves the report while destroying the signal.
- **Why this is a `warning`, not an `error`:** declaring a path under `test.evals` **is** the instruction not to package it, so VAT excludes it automatically — links into it are dropped from the bundle, and matching `files:` entries are skipped. Nothing is broken and no config edit is required; the build produces the correct artifact either way. This code exists only so a dropped link or a `files:` entry that silently did nothing is not mistaken for one that worked.
- **What happens to the link:** the target is not packaged, so the link is **rewritten away** — `[the suite](evals/evals.json)` ships as the bare text `the suite`. That is deliberate (a dead relative link in a published skill is worse), and this receipt is what makes it visible. VAT does not report it through the ordinary pattern-exclusion channel, which is silent by design: an `excludeReferencesFromBundle` rule is intent the author declared, whereas this exclusion is VAT's own policy applied to an author who declared an *eval suite*, not a link-stripping rule.
- **Fix:** None required. Remove the link or the `files:` entry to silence the warning, or move the target out of the `test.evals` directory if it is genuinely a shipped resource.
- **But a link TO the dropped `dest` is a separate, real error.** This code is a *receipt* for one skipped copy; it is not a blanket "everything about this entry is fine." If `SKILL.md` (or any bundled resource) links the `dest` that entry would have produced, that link points at a file the build will never write — so it is reported as a broken link (`LINK_MISSING_TARGET` in the skills lanes, `LINK_BROKEN_FILE` in `vat resources validate`) alongside this receipt, and the build fails. It is **not** downgraded to [`LINK_DEFERRED_ARTIFACT`](#link_deferred_artifact): that downgrade means "a build step will materialize this," and here VAT has already decided not to. All three lanes (`vat skills validate`, `vat resources validate`, `vat skills build` / the plugin build) agree on this. **Fix:** stop linking the dest, or move the source out of the `test.evals` directory so the entry is actually packaged.

### `PACKAGED_BROKEN_LINK`

- **Default:** `error`
- **What:** Link in the packaged output resolves to a file that is not present in the output.
- **Why it matters:** Whatever put the bundle in this state, the shipped artifact has a dead link, which is why this is a blocking `error`. Unlike `LINK_MISSING_TARGET`, which flags source issues, this flags a post-build integrity failure.
- **The `fix` names the cause; the message deliberately does not.** Two different things produce this state and only the lane that emitted the issue knows which one it is holding, so the cause is carried in the per-issue remediation rather than asserted in the description. **Read the `Fix:` line on the issue, not this heading**, to learn which case you have:
  - **A link-rewriter bug** (the dominant case): VAT copied or rewrote inconsistently and a file the output was supposed to contain is missing. The generic fix below applies — report it.
  - **A deliberate policy drop:** the link's target is a file a glob `files:` entry matched and the never-package filter dropped in this same build (see [`FILES_GLOB_DROPPED_NEVER_PACKAGED`](#files_glob_dropped_never_packaged)). The issue keeps this code and stays a blocking `error` — the bundle really does have a dead link — but its `fix` says so and tells you to declare the file explicitly, point the link at content that ships, or drop the link. It does **not** ask you to report a VAT bug, because there is none. The cause is keyed on the drop VAT actually performed, never on the filename: in a build where no glob ran, a broken link to a `README.md` is an ordinary broken link and gets the generic remediation below.
- **Fix:** Report the issue — this indicates a VAT bug. As a temporary workaround, set `severity.PACKAGED_BROKEN_LINK` to `ignore` while the underlying bug is fixed.

### `FILENAME_COLLISION`

- **Default:** `error`
- **What:** Two source files package to the same destination path in the bundle; one would overwrite the other. Most often two same-basename files in different directories under the default `basename` resource naming.
- **Why it matters:** The build cannot produce a correct artifact: one file's content is simply lost, and every link to either source resolves to whichever file was written last. It is an `error` for that reason, not as a style opinion — overriding it to `ignore` does not make the bundle correct, it only stops VAT from saying so.
- **Fix:** Rename one of the files, or switch `resourceNaming` to a path-based strategy (`resource-id` or `preserve-path`) so the sources map to distinct destinations.

Reported like every other packaging finding — a located, coded issue on the build's issue channel, naming the owning skill and both colliding paths in project-relative coordinates. A collision in one skill fails that skill; the rest of the batch still builds.

### `PLUGIN_EXCLUDE_PATTERN_UNUSED`

- **Default:** `warning`
- **What:** An `exclude:` pattern on a marketplace plugin entry matched no file in that plugin's source tree during `vat claude plugin build`, so it excluded nothing from the built bundle. One finding per dead pattern, quoting it exactly as authored.
- **Why it matters:** `exclude:` is the escape hatch for junk the never-package defaults cannot know about (scratch dirs, design notes, internal fixtures). A pattern that matches nothing is a knob that silently no-oped: the author believes the junk is being held back, and it ships anyway. Zero matches is the only evidence available — nothing downstream can tell a mis-spelled pattern from a directory that was already clean.
- **Reported as a finding, not a log line.** A file leaving (or failing to leave) a bundle is part of the delta between what the config asked for and what shipped, so it reaches the build's `issueCounts` like every other packaging finding. A build that quietly changed what ships while publishing `warnings: 0` is exactly what a CI consumer cannot see.
- **Why this is a `warning`, not an `error`:** the build produced a valid artifact and may need no edit at all — a pattern can go dead simply because the directory it targeted was deleted. It is louder than `info` because a pattern that no-ops is usually a typo, and the failure it hides (junk shipping to consumers) is invisible from the report.
- **Not a claim about shadowing.** Hit counting is per-pattern, so a pattern that matches files another pattern also matches is doing work and is never reported here.
- **Fix:** Check the pattern against the plugin source directory (patterns are relative to it, and a bare directory name covers its whole subtree), then correct the path — or drop the entry from the marketplace plugin entry's `exclude:` list if what it targeted no longer exists.

## Resource Registry Codes

*Fire when building the resource registry — `vat resources validate` and any command that crawls resources.*

### `DUPLICATE_RESOURCE_ID`

- **Default:** `error`
- **What:** Two files resolve to the same resource id after path normalization (e.g. `My Guide.md` and `my-guide.md` both produce `my-guide-md`).
- **Why it matters:** Resource ids must be unique — a collision means one file silently shadows the other in lookups, link resolution, and bundling. This surfaces as a reported issue rather than aborting the whole run with an uncaught error.
- **Fix:** Rename one of the files so they produce distinct resource ids.

### `RESOURCE_UNREADABLE`

- **Default:** `error`
- **What:** A file the crawl enumerated could not be read, so it was skipped. Most often a committed symlink whose target is missing; also permissions, or a file deleted between enumeration and parse.
- **Why it matters:** The file is absent from every count in the report — `filesScanned`, link totals, bundle contents — while the crawl found it. Before this code existed, an unreadable file terminated `vat resources scan`/`validate` and `vat audit` with a raw `ENOENT` stack trace; the alternative of skipping it quietly would have traded a loud crash for a silent population change, which is worse. The finding names the file so the gap between "enumerated" and "validated" is accounted for rather than inferred.
- **Scope:** Only recognized filesystem errno codes (`ENOENT`, `EACCES`, `ELOOP`, `EISDIR`, …) are reported this way. A parse or indexing defect still throws, so a bug in VAT cannot disguise itself as a per-file warning.
- **Fix:** Repoint or delete the dangling symlink, restore the missing target, or fix the permissions. Set `severity.RESOURCE_UNREADABLE` to `warning` if a corpus is expected to contain unresolvable entries.

## Quality Codes

*Stance: see [Length and Shape](./skill-quality-and-compatibility.md#length-and-shape) and [Authoring](./skill-quality-and-compatibility.md#authoring).*

Best-practice checks about skill shape and content.

### `SKILL_LENGTH_EXCEEDS_RECOMMENDED`

- **Default:** `warning`
- **What:** `SKILL.md` line count exceeds the recommended limit; longer files degrade skill triggering.
- **Why it matters:** LLMs use the skill description and early content to decide whether to invoke a skill. Excessively long `SKILL.md` files dilute the trigger signal and slow down skill matching across large plugin sets.
- **Fix:** Split content into linked resources (progressive disclosure) or allow if the length is justified.

### `SKILL_TOTAL_SIZE_LARGE`

- **Default:** `warning`
- **What:** Total packaged line count exceeds the recommended limit.
- **Why it matters:** A large total bundle consumes context window when loaded. Skills that load too much content crowd out other skills and reduce the agent's effective working space during a session.
- **Fix:** Reduce bundled content, move references out of the bundle, or allow if the size is justified.

### `SKILL_TOO_MANY_FILES`

- **Default:** `warning`
- **What:** Packaged file count exceeds the recommended limit.
- **Why it matters:** Skills with many files are harder to maintain, harder for agents to navigate, and slower to load. High file counts often indicate a skill that should be split into multiple focused skills.
- **Fix:** Consolidate or restructure references, or allow if the file count is justified.

### `REFERENCE_TOO_DEEP`

- **Default:** `warning`
- **What:** Bundled link graph exceeds the recommended depth; deeply nested references hurt discoverability.
- **Why it matters:** Deeply nested reference graphs require many hops for agents to reach leaf content. Information buried several levels deep is rarely surfaced and harder to keep consistent.
- **Fix:** Flatten the reference structure or allow if depth is intentional.

### `DESCRIPTION_TOO_VAGUE`

- **Default:** `warning`
- **What:** `SKILL.md` description is too short to reliably trigger the skill.
- **Why it matters:** The description is the primary signal the LLM uses to decide whether to invoke a skill. A vague or minimal description causes the skill to be overlooked or triggered too broadly for unrelated requests.
- **Fix:** Expand the description with concrete triggers and use cases.

### `NO_PROGRESSIVE_DISCLOSURE`

- **Default:** `warning`
- **What:** Long `SKILL.md` with no linked references; progressive disclosure recommended.
- **Why it matters:** A long flat `SKILL.md` loads all content immediately into context regardless of what the agent needs. Progressive disclosure — linking to separate files — allows agents to load only what is relevant to the current task.
- **Fix:** Move background detail into linked resources and reference them from `SKILL.md`.

### `SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT`

- **Default:** `warning`
- **What:** Frontmatter `description` exceeds 250 characters.
- **Why it matters:** Claude Code's `/skills` listing truncates descriptions at 250 characters (since v2.1.86). Descriptions longer than this lose their tail — and trigger keywords placed late in the description may never be visible to users scanning the listing.
- **Fix:** Shorten the description below 250 chars. Target ≤200 for a safety margin, or ≤130 if shipping a large skill collection (60+ skills) so the total budget fits. The softer companion to the 1024-char hard schema limit (`SKILL_DESCRIPTION_TOO_LONG`).

### `SKILL_DESCRIPTION_FILLER_OPENER`

- **Default:** `warning`
- **What:** Description opens with a meta-filler phrase that describes the skill-as-object rather than what it does (e.g., `This skill...`, `A skill that...`, `Used to...`, `Use when you want to...`, `Use when you need to...`).
- **Why it matters:** These openers waste the first — and highest-weighted — tokens of the description on boilerplate rather than trigger keywords. Anthropic's own examples never use them. Note: `Use when <concrete trigger>` is the recommended pattern and is explicitly allowed; only the vague `you want/need` variants are flagged.
- **Fix:** Lead with a verb phrase (`Extracts text from PDFs...`) or `Use when <concrete trigger>`.

### `SKILL_DESCRIPTION_WRONG_PERSON`

- **Default:** `warning`
- **What:** Description uses first-person (`I can...`, `I'll...`, `I'm able to...`) or conversational second-person (`You can...`, `You'll...`, `You should...`) patterns anywhere in the text.
- **Why it matters:** Anthropic's guidance is unambiguous: "Always write in third person. The description is injected into the system prompt, and inconsistent point-of-view can cause discovery problems." Their bad examples are literally `I can help you process Excel files` and `You can use this to process Excel files`.
- **Fix:** Rewrite in third person. `I can extract PDFs` → `Extracts text from PDFs`. `You can use this to...` → the action itself (`Processes...`, `Generates...`).

### `SKILL_CLAUDE_PLUGIN_NAME_MISMATCH`

- **Default:** `warning`
- **What:** For a [skill-claude-plugin](./architecture/skill-packaging.md) (a directory with both root `SKILL.md` and `.claude-plugin/plugin.json`), the plugin manifest's `name` does not match the skill's frontmatter `name`.
- **Why it matters:** In a skill-claude-plugin, the skill is the authoritative artifact and the plugin is a Claude-specific distribution wrapper. Name drift between the two confuses users (which name shows up in their installed-plugins list? which is referenced in config?) and usually indicates a packaging oversight. For canonical plugins (skills under `skills/<name>/`), this code does not apply — plugin names and individual skill names are independent by design.
- **Fix:** Align the names — update `plugin.json` `name` to match the skill's frontmatter `name` (the skill is authoritative). If the plugin is intentionally namespaced differently (e.g., `com.author.foo-plugin`), configure `validation.severity: { SKILL_CLAUDE_PLUGIN_NAME_MISMATCH: ignore }` or add a `validation.allow` entry with a reason.

### `SKILL_NAME_MISMATCHES_DIR`

- **Default:** `warning`
- **What:** The `name` field in frontmatter does not match the skill's parent directory name (kebab-case comparison). Skipped when `name` is omitted — schema inference handles that case.
- **Why it matters:** Agents resolve skills by name; a mismatch between the declared name and the directory the skill lives in usually indicates a copy/paste bug during authoring. Built outputs derive directory names from the frontmatter, so a mismatch at the source means the packaged artifact will appear under a different name than its source location suggests.
- **Fix:** Align them — rename the directory to match `name`, or update `name` to match the directory.

### `RESERVED_WORD_IN_NAME`

- **Default:** `warning`
- **What:** Frontmatter `name` contains a reserved word (`anthropic` or `claude`); Claude Code rejects non-certified skills using these words.
- **Why it matters:** Claude Code refuses to install skills containing `anthropic` or `claude` in the `name` unless they come from Anthropic's official certified set. Catching this at validate time shifts the failure left — from "Claude Code silently rejects my install" to a warning in `vat audit` / `vat skills validate` before the skill ships. Warning (not error) because some adopters may have legitimate downstream reasons to keep the name and accept the install restriction.
- **Fix:** Rename the skill to avoid `anthropic` or `claude` in the name (e.g. `claude-helper` → `conversation-helper`). Allow via `validation.severity: { RESERVED_WORD_IN_NAME: ignore }` if the skill is a certified Anthropic distribution.

### `SKILL_TIME_SENSITIVE_CONTENT`

- **Default:** `info`
- **What:** `SKILL.md` body contains a time-sensitive phrase (`as of November 2025`, `after July 2026`, `before March 2025`, `until December 2024`, or the year-first form `as of 2026-04`). One issue fires per matched line.
- **Why it matters:** Anthropic's best-practices doc advises against content that will become outdated — time-sensitive prose goes stale and misleads agents. The `info` severity reflects that this is sometimes intentional (historical context); it surfaces the pattern without asserting it is wrong.
- **Fix:** Remove the time qualifier, or move deprecated guidance into a clearly labeled `## Old patterns` section with a `<details>` block so agents skip it.

### `NON_PORTABLE_ASSET_REFERENCE`

- **Default:** `warning`
- **What:** A skill document references a bundled script/asset via a non-portable anchor — a path that won't resolve across the surfaces a skill runs on. This is a **family** of sub-checks rolled up under one code; each finding names the variant that fired (`[<label>]`) and carries a tailored fix. Current variants:
  - `claude-plugin-root` — `$CLAUDE_PLUGIN_ROOT` / `${CLAUDE_PLUGIN_ROOT}`
  - `claude-project-dir` — `$CLAUDE_PROJECT_DIR` / `${CLAUDE_PROJECT_DIR}`
  - `absolute-script-path` — an absolute path passed to a runtime (`node /Users/…/run.mjs`, etc.)

  Scans the `SKILL.md` body **and every markdown doc reachable through it** (the bundled link graph), since agents copy invocations from reference files too. One issue fires per matched line, located at the offending file (case-sensitive, so lowercase prose mentions are not flagged). Matching is brace-balanced: `${VAR:-$CLAUDE_PROJECT_DIR}` reports `$CLAUDE_PROJECT_DIR`, never the enclosing expansion's closing brace.
- **Why it matters:** These anchors are Claude Code-specific or machine-specific — none are part of the portable Agent Skills contract, and they don't exist when the skill is mounted standalone (a claude.ai upload, an API container, `~/.claude/skills/`). `CLAUDE_PLUGIN_ROOT` in particular resolves to the *plugin* directory, not the skill, so authors append a `skills/<name>/…` segment that only exists under plugin mounting; under a standalone mount that path 404s on the agent's first invocation. Anthropic's [skill authoring best practices](https://platform.claude.com/docs/en/docs/agents-and-tools/agent-skills/best-practices) reference bundled scripts by skill-relative paths exclusively.
- **Fix:** For `claude-plugin-root` and `absolute-script-path`, reference bundled files by a path relative to the skill directory (e.g. `scripts/run.mjs`), never via an env-var anchor or absolute path. See the `vibe-agent-toolkit:vat-skill-authoring` skill → "Referencing bundled scripts and assets". `claude-project-dir` is different — see the note below.
- **The `claude-project-dir` variant has no mechanical fix.** `CLAUDE_PROJECT_DIR` is not an asset reference — it denotes the *user's repository*, the thing the skill operates **on**, not something it ships, and no skill-relative path can express it. Do not "fix" it by substituting a relative path; that changes the meaning and can re-anchor user artifacts onto the plugin install directory. If the skill genuinely operates on the user's project, take the location as an explicit parameter with `$CLAUDE_PROJECT_DIR` as a fallback, and ensure the skill's declared `targets` reflect the Claude Code dependency. The variant is retained because the coupling is real and worth surfacing — but it is a portability *fact*, not a defect.
- **Overriding:** because every variant emits this one code, a single `validation.allow` entry (or severity override) silences the **whole family** for a file — adding an esoteric variant never multiplies the override surface. Allow `paths` match the offending file's location, so an intentional mention (e.g. a doc teaching the anti-pattern) can be scoped to that doc.
- **Extending:** add a variant by appending a `{ label, pattern, fix }` row to `NON_PORTABLE_ASSET_VARIANTS` in `packaging-validator.ts` — no new top-level code. (Absolute Windows paths are covered separately by `PATH_STYLE_WINDOWS`.)

### `NON_PORTABLE_COMMAND`

- **Default:** `warning`
- **What:** A skill document instructs an agent to run a shell command that hard-codes a GNU/Linux-only utility or flag. This is a **family** of sub-checks rolled up under one code; each finding names the variant that fired (`[<label>]`) and carries a tailored fix. Current variants:
  - `timeout` — `timeout <arg>` (not installed on macOS by default)
  - `grep-pcre` — `grep -P` / `grep --perl-regexp` (PCRE unsupported by BSD/macOS grep)
  - `sed-i-no-backup` — `sed -i` with no attached suffix (GNU `sed -i` vs BSD `sed -i ''` differ; `sed -i.bak` is portable and not flagged)
  - `readlink-f` — `readlink -f` (on macOS, fails when the final path component does not exist, where GNU canonicalizes it; `-f` was absent from macOS entirely for years)
  - `date-d` — GNU `date -d` (BSD uses `-v` / `-j -f`)

  Patterns match commands in **command position** only — start of line, or after a pipe/semicolon/ampersand or a backtick/code fence — so bare prose nouns ("the request will timeout", "grep the logs") are not flagged. Scans the `SKILL.md` body **and every markdown doc reachable through it** (the bundled link graph), since agents copy invocations from reference files too. One issue fires per matched line, located at the offending file.
- **Why it matters:** Agents copy bundled commands verbatim. A command that only works on GNU/Linux fails the moment the skill runs on macOS/BSD — `timeout` is absent, `grep -P` errors, `sed -i` mangles its arguments, `readlink -f` fails on a not-yet-existing path, and `date -d` is rejected. The skill that "works on my machine" breaks on the user's first invocation elsewhere.
- **Maintaining the variants:** every variant asserts macOS/BSD behaviour that CI (Ubuntu + Windows only) cannot contradict, so the table is annotated `@vendor-claim` in `packaging-validator.ts` and comes due for re-verification on a clock. When a variant's macOS behaviour converges with GNU, **delete the variant** rather than rewording it — a detector that fires on portable code teaches adopters to ignore the code.
- **Fix:** Use a portable equivalent: `grep -E` for PCRE; `sed -i.bak`/an explicit suffix (or a temp file) instead of bare `sed -i`; a portable resolve instead of `readlink -f`; `date -v`/`-j -f` instead of `date -d`; gate `timeout` on availability (`command -v timeout`) or drop it. See the `vibe-agent-toolkit:vat-skill-review` skill.
- **Overriding:** because every variant emits this one code, a single `validation.allow` entry (or severity override) silences the **whole family** for a file — adding an esoteric variant never multiplies the override surface. Allow `paths` match the offending file's location, so an intentional mention (e.g. a doc teaching the anti-pattern) can be scoped to that doc.
- **Extending:** add a variant by appending a `{ label, pattern, fix }` row to `NON_PORTABLE_COMMAND_VARIANTS` in `packaging-validator.ts` — no new top-level code.

### `SKILL_FRONTMATTER_EXTRA_FIELDS`

- **Default:** `warning`
- **What:** Frontmatter contains a field outside the standard agentskills.io + Claude Code key set (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`, `argument-hint`, `disable-model-invocation`, `user-invocable`, `model`, `context`, `agent`, `hooks`). One issue fires per non-standard field.
- **Why it matters:** Non-standard frontmatter keys are silently ignored by spec-compliant consumers and create a portability trap — a project-specific `version:` or `team:` field looks declarative but carries no semantics off that project. The allowed set is derived from the Zod schema so it stays in sync as the spec evolves.
- **Fix:** Move custom data under `metadata.<key>`, or remove the field. Per-project configuration belongs in `vibe-agent-toolkit.config.yaml`, not SKILL.md frontmatter. Allow via `validation.severity: { SKILL_FRONTMATTER_EXTRA_FIELDS: ignore }` if the field is required by a non-VAT downstream consumer.

### `SKILL_CROSS_SKILL_AUTH_UNDECLARED`

- **Default:** `warning`
- **What:** `SKILL.md` body contains a `requires` / `depends on` phrase within ~60 characters of a backtick-wrapped sibling skill reference (`` `plugin:skill-name` ``) or an `ANTHROPIC_*_API_KEY` / `ANTHROPIC_*_KEY` environment variable, but the frontmatter `description` does not name that dependency (case-insensitive substring or humanized shard match).
- **Why it matters:** Agents select skills by description alone — if the description does not mention a prerequisite, the agent can load this skill without loading the sibling it depends on, or run it in an environment missing the required credential. The failure surfaces at runtime as a confusing error rather than a skill that refused to load.
- **Fix:** Name the dependency in the description (e.g. `Requires ado skill for auth`, `Uses the Anthropic Admin API. Requires ANTHROPIC_ADMIN_API_KEY.`). Allow via `validation.allow` with a `reason` when the dependency is genuinely runtime-optional.

### `SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE`

- **Default:** `warning`
- **What:** Sibling skills in the same package use a mix of YAML scalar styles for their `description` frontmatter line — folded (`description: >-`), literal (`description: |`), inline double-quoted (`description: "..."`), inline single-quoted (`description: '...'`), or inline plain. When two or more styles appear together, every skill in the package with a classifiable style receives the warning.
- **Why it matters:** Consistent YAML styling across a skill package is a low-cost signal that the skills were authored deliberately together. Mixed styles usually reflect copy-paste from heterogeneous sources and make packaging refactors (renames, reformats) noisier than they need to be. The rule is package-scoped because within-skill style is invisible to agents — it only matters when compared against siblings.
- **Fix:** Pick one YAML style and apply it to every skill in the package. Allow via `validation.severity: { SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE: ignore }` per package when mixing is deliberate.

### `PLUGIN_MISSING_DESCRIPTION`

- **Default:** `info`
- **What:** `.claude-plugin/plugin.json` lacks a `description` field.
- **Why it matters:** Plugin-dev's "Recommended Metadata" section names `description` as recommended. Claude Code surfaces the manifest description in the `/plugin` listing; without it, users see only the plugin name when browsing installed plugins.
- **Fix:** Add `"description": "..."` to plugin.json.

### `PLUGIN_MISSING_AUTHOR`

- **Default:** `info`
- **What:** `.claude-plugin/plugin.json` lacks an `author` field (or `author.name`).
- **Why it matters:** Plugin-dev names `author` as recommended metadata. Authorship is what makes "report upstream" actionable for corpus scanning, marketplace discovery, and downstream issue-routing.
- **Fix:** Add `"author": { "name": "..." }` to plugin.json.

### `PLUGIN_MISSING_LICENSE`

- **Default:** `info`
- **What:** `.claude-plugin/plugin.json` lacks a `license` field.
- **Why it matters:** Plugin-dev recommends `license`. License absence in shipped artifacts creates downstream redistribution ambiguity — adopters cannot tell at a glance whether a plugin is safe to vendor or extend.
- **Fix:** Add `"license": "MIT"` (or appropriate SPDX identifier) to plugin.json.

### `PLUGIN_TOPLEVEL_BIN_DIR`

- **Default:** `warning`. Deliberately **not** escalated by strict marketplace validation — see "Evidence" below.
- **What:** The plugin directory contains a non-empty top-level `bin/`.
- **Why it matters:** `bin/` and `scripts/` mean different things. Anthropic's [plugins reference](https://code.claude.com/docs/en/plugins-reference) documents `bin/` as *"Executables added to the Bash tool's `PATH`. Files here are invokable as bare commands in any Bash tool call while the plugin is enabled"*. `scripts/` is the conventional home for helper scripts a plugin ships — it is what the plugin-dev skill's recognized-directory list names, and helper scripts there are invoked by path rather than bare. A plugin whose executables are always invoked by an explicit path (`node "${CLAUDE_PLUGIN_ROOT}/bin/tool.mjs"`) is therefore using `bin/` without using what `bin/` provides.
- **Evidence — read this before raising the severity:** `bin/` is a **supported, documented** Claude Code feature (shipped in v2.1.91), and no published Anthropic source restricts it. Separately, a claude.ai-hosted marketplace sync has been **observed** to skip a plugin because it shipped a top-level `bin/`, surfacing only on the org admin console; the publish itself succeeded, so the plugin silently never appeared. VAT has **one** such observation and no documentation confirming the rule. That asymmetry is why this ships at `warning` and why the message reports an observation rather than asserting a restriction. If Anthropic documents the restriction, or the corpus produces more instances, revisit the severity per [validation-rule-design.md](validation-rule-design.md). The full evidence log — including what would change this verdict — is in [plugin-distribution-findings.md](contributing/plugin-distribution-findings.md).
- **Fix:** If nothing invokes these as bare commands, move them to `scripts/` and reference them by path. Keep `bin/` if you genuinely rely on PATH exposure and distribute through the Claude Code CLI — set `severity.PLUGIN_TOPLEVEL_BIN_DIR` to ignore, or scope a `validation.allow` entry to the plugin so the decision is recorded with a reason.
- **When it's fine:** A CLI-distributed plugin that wants bare-command invocation is using `bin/` exactly as designed.

### `PLUGIN_NAME_NOT_KEBAB_CASE`

- **Default:** `info`
- **What:** Plugin manifest `name` does not match `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase alphanumeric with single hyphens).
- **Why it matters:** Plugin-dev's "Name requirements" section: kebab-case is mandatory in Claude Code. The Zod schema already errors via `PLUGIN_INVALID_SCHEMA`; this dedicated code makes the finding actionable in audit output (the message names the convention rather than echoing a generic schema error).
- **Fix:** Rename to kebab-case. The schema-level error blocks the build regardless of this info code's severity; raising severity to `error` here is redundant.

### `SKILL_NAME_NOT_KEBAB_CASE`

- **Default:** `info`
- **What:** SKILL.md frontmatter `name` does not match `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase alphanumeric with single hyphens).
- **Why it matters:** Sister rule to `PLUGIN_NAME_NOT_KEBAB_CASE`; plugin-dev applies the same convention to skills. The Zod schema already errors via `SKILL_NAME_INVALID`; this dedicated code surfaces the same finding with a more actionable message.
- **Fix:** Rename to kebab-case.

### `SKILL_REFERENCES_BUT_NO_LINKS`

- **Default:** `info`
- **What:** A skill directory contains `scripts/`, `references/`, or `assets/` subdirectories, but the SKILL.md body has zero markdown links pointing into any of them.
- **Why it matters:** Plugin-dev's "Mistake 4: Missing Resource References" — bundled assets the body never links to are dead weight in the install. They ship but never load. This pattern often signals an author who intended progressive disclosure but didn't wire up the references.
- **Fix:** Add explicit markdown links from SKILL.md (or a linked file) into the bundled subdirectories, or remove the unreferenced directory. Assets consumed programmatically belong in `skills.config.<name>.files` as source/dest pairs — a declared dest is exempt, so do NOT restate them in `validation.allow`.

### `SKILL_BODY_NOT_IMPERATIVE`

- **Default:** `info`
- **What:** SKILL.md body contains second-person instructional openers — lines starting with `You ` followed by a modal verb (`should`, `can`, `need`, `must`, `will`, `may`) outside fenced code blocks and quoted blocks.
- **Why it matters:** Plugin-dev's "Mistake 3: Second Person Writing" calls this out as a top anti-pattern. Imperative form ("Configure the…") is more agent-readable than addressing a reader ("You should configure…"). Heuristic with bounded false-positive risk; ship at info to gather corpus signal before promoting.
- **Fix:** Rewrite as imperative ("Configure the MCP server…" instead of "You should configure…"). Allow via `validation.allow` if the line is documenting user dialog or a quoted prompt the heuristic mis-fires on.

## Plugin Inventory Codes

Structural checks derived from the plugin inventory layer. These codes fire when the inventory model detects a mismatch between what a manifest declares and what exists on disk. They are emitted during `vat audit` (and any future command that consumes the inventory layer). All four are detector-based (pure functions) — no filesystem I/O at detection time.

### `COMPONENT_DECLARED_BUT_MISSING`

- **Default:** `warning`
- **What:** A component path declared in the plugin manifest (`skills`, `commands`, `agents`, `hooks`, `mcpServers`, `outputStyles`, or `lspServers`) does not exist on disk.
- **Why it matters:** Claude Code logs a warn-level message and continues install when a declared component is absent — the plugin installs but the missing component is silently skipped. This is often a path typo, a file that was deleted without updating the manifest, or a build artifact that was not generated. Catching it at audit time shifts the failure from a silent runtime skip to a visible pre-flight warning.
- **Fix:** Add the missing file, remove the manifest declaration, or correct the path. Use `validation.allow` if the artifact is intentionally generated by an install-time build step.

### `COMPONENT_PRESENT_BUT_UNDECLARED`

- **Default:** `info`
- **What:** A component (skill, command, or agent) is present under the canonical layout but the manifest declares an explicit list that omits it; the runtime may silently skip it at install.
- **Why it matters:** Claude Code applies auto-discovery when the manifest _omits_ a field entirely. But when the manifest provides an explicit list (including an empty `[]`), auto-discovery is suppressed — only listed components are installed. A file that ships but is absent from the explicit list will be silently skipped. This code fires only when `declared !== null` (explicit list present); a missing field is intentional auto-discovery and is not flagged.
- **Fix:** Add the component to the appropriate manifest field, or remove the file if unintended. Skipped when the manifest omits the field entirely.

### `REFERENCE_TARGET_MISSING`

- **Default:** `error`
- **What:** A cross-component reference resolved from the manifest (e.g., a hook's `script` path, an MCP server's `path`) points to a file that does not exist on disk.
- **Why it matters:** These are direct manifest-level pointers — not auto-discovered paths but explicit path declarations. A missing target means the component cannot be loaded at all. Unlike a missing declared component (which the loader skips), a broken cross-reference causes the manifest to be malformed in a way that prevents the referencing component from initializing.
- **Fix:** Add the referenced file or correct the path in the manifest.

### `MARKETPLACE_PLUGIN_SOURCE_MISSING`

- **Default:** `error`
- **What:** A marketplace manifest declares a plugin with a `path`-based source that does not exist on disk.
- **Why it matters:** Path sources in a marketplace are filesystem-relative installation targets. A missing source means the marketplace cannot install the plugin — the path is either a typo, a relative path that drifted after a directory move, or a build artifact that was never generated. Git/npm/unknown sources are out of scope (they resolve at install time from remote sources).
- **Fix:** Correct the source path or remove the entry from `marketplace.plugins[]`.

## Plugin Registry Codes

*Fire when validating the plugin registries Claude Code writes and owns — `installed_plugins.json` and `known_marketplaces.json` — during `vat audit`.*

These files are external data: VAT reads them, Claude Code writes them. Per VAT's Postel's Law rule (be liberal in what you accept from files you do not control) the schemas parse them **liberally** — unknown fields and unknown scope values pass through untouched instead of failing the run. Structural breakage (a missing `version`, a malformed plugin key, a non-array entry list) is still `REGISTRY_INVALID_SCHEMA` at `error`.

### `REGISTRY_SHAPE_DRIFT`

- **Default:** `info`
- **What:** An installed-plugins registry carries a field or a `scope` value that VAT's model does not recognize — the file Claude Code writes is newer than the model VAT reads it with. One observation per distinct unknown, not per entry.
- **Why it matters:** Liberal parsing alone would trade false errors for total blindness: Claude Code could add three new fields and a new install scope and VAT would report a clean run forever. This code is the visible half of the trade — VAT accepts the shape it does not understand *and says so*. It is the signal that VAT's registry model has fallen behind, and the input for updating it.
- **Fix:** No action needed — the unknown value was preserved, not rejected. Report the field so VAT's model can catch up, or set `severity.REGISTRY_SHAPE_DRIFT` to `ignore`.

## Compat Codes

*Stance: see [Compatibility](./skill-quality-and-compatibility.md#compatibility).*

Compat reasoning is layered. Parsers emit neutral **evidence records** (pattern matches with file/line/confidence). Evidence is rolled into **capability observations** — domain claims like "this skill requires local shell" — emitted as `CAPABILITY_*` codes at `info` severity. A verdict engine then compares observations against the plugin's declared targets and their runtime profiles, emitting `COMPAT_TARGET_*` codes only when there is an actual mismatch.

Capability observations are declarations, not judgments. When a plugin declares `targets: [claude-code]`, a `CAPABILITY_LOCAL_SHELL` observation matches — no verdict fires. Without a declared target, `COMPAT_TARGET_UNDECLARED` surfaces at `info` so adopters can make the decision explicit.

Scope in v1: detectors run against SKILL.md and its transitively linked markdown. Plugin-wide compat (hooks, `.mcp.json`) is covered by the `vat audit --compat` analyzer consuming the same observation/verdict pipeline.

### `CAPABILITY_LOCAL_SHELL`

- **Default:** `info`
- **What:** Skill references a local-shell tool (`Bash`/`Edit`/`Write`/`NotebookEdit`) or invokes a shell via fenced `bash`/`sh`/`shell`/`zsh` blocks.
- **Why it matters:** Local-shell access only exists on runtimes like Claude Code or Cowork. Surfacing the capability as an observation lets the verdict engine decide whether the declared target covers it.
- **Fix:** Informational. Declare a plugin target that provides shell (`claude-code`, `claude-cowork`) so this observation resolves to an expected verdict. Run `vat audit --verbose` to see the supporting evidence.

### `CAPABILITY_EXTERNAL_CLI`

- **Default:** `info`
- **What:** Skill invokes an external CLI binary not bundled with the skill (`az`, `aws`, `gcloud`, `kubectl`, `docker`, `terraform`, `gh`, `op`). One observation fires per distinct binary with `payload: { binary }`.
- **Why it matters:** External CLIs are environment-dependent. The runtime profile records which binaries are guaranteed; the verdict engine flags `COMPAT_TARGET_NEEDS_REVIEW` when a declared target has shell but no guarantee.
- **Fix:** Informational. Ensure the declared target guarantees the binary, or document the prerequisite.

### `CAPABILITY_BROWSER_AUTH`

- **Default:** `info`
- **What:** Skill appears to require an interactive browser login flow (MSAL imports, `az login`, `gcloud auth login`, `aws sso login`, `webbrowser.open()`).
- **Why it matters:** Browser-based auth requires a runtime with a browser capability. Non-browser auth (service principal, bearer tokens) is portable and intentionally not flagged.
- **Fix:** Informational. If a service-principal or bearer-token flow would work, prefer it. Otherwise declare a browser-capable target.

### `COMPAT_TARGET_INCOMPATIBLE`

- **Default:** `warning`
- **What:** The plugin's declared target runtime definitively lacks a required capability (e.g., `CAPABILITY_LOCAL_SHELL` observation on a `claude-chat`-only plugin).
- **Why it matters:** This is a genuine mismatch — the skill cannot run on the declared target. Emitted by the verdict engine using the runtime profile table as the source of truth.
- **Fix:** Narrow the declared target to runtimes that support the capability, or allow with a reason if the mismatch is intentional.

### `COMPAT_TARGET_NEEDS_REVIEW`

- **Default:** `warning`
- **What:** The declared target's capability profile covers the axis but a specific resource is uncertain (e.g., external CLI binary not in the target's preinstalled set).
- **Why it matters:** Between "definitely works" and "definitely broken" — the adopter should document the prerequisite or allow the issue with a reason.
- **Fix:** Document the prerequisite in the skill description or allow with a reason.

### `COMPAT_TARGET_UNDECLARED`

- **Default:** `info`
- **What:** The skill has capability observations but no target is declared at any layer (`plugin.json`, `marketplace.json` defaults, `vibe-agent-toolkit.config.yaml`).
- **Why it matters:** Absence of a target declaration is not the same as "compatible everywhere." Surfacing the gap lets adopters make the choice explicit.
- **Fix:** Declare targets in `vibe-agent-toolkit.config.yaml` (`skills.config.<name>.targets`), `plugin.json`, or marketplace defaults.

## Meta Codes

*Stance: see [Configuration Meta](./skill-quality-and-compatibility.md#configuration-meta).*

Describe the state of the validation config itself.

### `ALLOW_EXPIRED`

- **Default:** `warning`
- **What:** A `validation.allow` entry's `expires` date is in the past; the allow entry still applies but should be re-reviewed.
- **Why it matters:** Time-boxed allow entries let you allow an issue temporarily and force re-review later. The allow entry still applies past the expiry; the warning is your reminder to deal with the underlying issue. Without this check, expired allow entries silently suppress issues indefinitely.
- **Fix:** Re-review the allow entry: extend `expires`, remove the entry, or fix the underlying issue. Upgrade severity to `error` for zero-tolerance expiry.

### `ALLOW_UNUSED`

- **Default:** `warning`
- **What:** A `validation.allow` entry did not match any emitted issue; the allow entry is dead weight.
- **Why it matters:** Unused allow entries indicate that the underlying issue was fixed, the path pattern no longer matches, or the entry was added in error. Dead entries in the config create false confidence that issues are being tracked when they are not.
- **Fix:** Remove the entry or fix the pattern. Upgrade severity to `error` to block on unused allow entries.

## Migration from `ignoreValidationErrors`

| Old | New |
| --- | --- |
| `ignoreValidationErrors: { CODE: "reason" }` | `validation.severity: { CODE: ignore }` |
| `ignoreValidationErrors: { CODE: { reason, expires } }` | `validation.severity: { CODE: ignore }` for code-wide silence, OR `validation.allow: { CODE: [{ paths, reason, expires }] }` for scoped allow entries with re-review on expiry |
