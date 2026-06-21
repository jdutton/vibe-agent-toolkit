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
          PACKAGED_UNREFERENCED_FILE:
            - paths: ["internal/*.json"]
              reason: "consumed programmatically at runtime"
              expires: "2026-09-30"
          SKILL_LENGTH_EXCEEDS_RECOMMENDED:
            - reason: "whole-skill concern; paths defaults to ['**/*']"
```

`validation.severity` sets class-level behavior; `validation.allow` suppresses specific `(code, path)` instances with an audit trail. `paths` is optional on allow entries and defaults to `["**/*"]` (the whole skill). Full docs at the VAT agent-authoring skill.

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
| [`LINK_TO_NAVIGATION_FILE`](#link_to_navigation_file) | warning | Markdown link targets a navigation file (README.md, index.md, etc.) which was excluded from the bundle. | Link to the specific content instead of the navigation file, or set severity.LINK_TO_NAVIGATION_FILE to ignore if this is intentional. |
| [`LINK_TO_GITIGNORED_FILE`](#link_to_gitignored_file) | error | Markdown link targets a gitignored file; risks leaking ignored data into the bundle. | Link to a non-ignored file or adjust .gitignore. Allow the specific path via validation.allow if the risk has been reviewed. |
| [`LINK_MISSING_TARGET`](#link_missing_target) | error | Markdown link target does not exist on disk and is not a declared build artifact. | Fix the link path, create the file, or declare it under skills.config.<name>.files as a build artifact. |
| [`LINK_DEFERRED_ARTIFACT`](#link_deferred_artifact) | info | Link targets a deferred build artifact declared in the skill files: config; it will exist after the build materializes it. | No action needed if the files: entry is correct. To silence, set validation.severity.LINK_DEFERRED_ARTIFACT: ignore. |
| [`FILES_SOURCE_GITIGNORED`](#files_source_gitignored) | warning | A files: source is gitignored — it will be copied into the published bundle; confirm it contains no secrets. | If this is an intentional build artifact (e.g. a bundled CLI from dist/), acknowledge it with a validation.allow entry that includes a reason. To change severity, set validation.severity.FILES_SOURCE_GITIGNORED. |
| [`LINK_TO_SKILL_DEFINITION`](#link_to_skill_definition) | error | Markdown link targets another skill's SKILL.md; bundling it creates duplicate skill definitions. | Link to a specific resource inside the other skill, or reference the other skill by name. |
| [`LINK_DROPPED_BY_DEPTH`](#link_dropped_by_depth) | warning | Walker stopped following links at the configured linkFollowDepth; this link was not bundled. | Raise linkFollowDepth, bundle the file via files config, declare the drop intentional with validation.allow, or exclude via excludeReferencesFromBundle.rules. |
| [`PACKAGED_UNREFERENCED_FILE`](#packaged_unreferenced_file) | error | File in the packaged output is not referenced from any packaged markdown. | Add a markdown link or code-block mention in SKILL.md or a linked resource. Allow via validation.allow if the file is consumed programmatically. |
| [`PACKAGED_BROKEN_LINK`](#packaged_broken_link) | error | Link in the packaged output resolves to a file that is not present in the output (likely a link-rewriter bug). | Report the issue — this indicates a VAT bug. As a temporary workaround, set severity.PACKAGED_BROKEN_LINK to ignore while the underlying bug is fixed. |

<!-- END:rule-catalog -->

### Disambiguation map (symptom × intent → code)

The same surface symptom (a "broken" link or an "orphan" file) means different
things depending on **intent**. This view names the broken⇄orphan oscillation
and shows the `files:` edge as the resolving state once `deferredPaths` is wired.

| Symptom | Intent behind the file | Resolves to |
|---|---|---|
| Broken link | Build artifact declared in `files:` (not yet materialized) | `LINK_DEFERRED_ARTIFACT` (info — resolves after build) |
| Broken link | Typo / wrong path at source | `LINK_MISSING_TARGET` |
| Broken link | Present in source but missing in **built** output | `PACKAGED_BROKEN_LINK` (link-rewriter bug) |
| Orphan file | Runtime asset loaded by a script | Declare in `files:` → no code (declaration is the resolution) |
| Orphan file | Forgotten / undocumented doc | `PACKAGED_UNREFERENCED_FILE` (link it or remove it) |
| Leaves the bundle | Links a gitignored file / gitignored `files:` source | `LINK_TO_GITIGNORED_FILE` / `FILES_SOURCE_GITIGNORED` |
| Leaves the bundle | Target outside the project root | `LINK_OUTSIDE_PROJECT` |
| Directory target | Navigational prose link | *valid — no code* |
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
- **Fix:** Point the typed reference at a specific file, not a directory.

> **Decision record D7 — directory index resolution (GitHub-style `docs/` → `docs/README.md`) is intentionally out of scope.** Because navigational prose links to a directory are now valid targets, there is no need to infer an index file; the directory link is simply allowed as-is. Implementing index resolution would add complexity for no benefit under the current model.

### `LINK_TO_NAVIGATION_FILE`

- **Default:** `warning`
- **What:** Markdown link targets a navigation file (`README.md`, `index.md`, etc.) which was excluded from the bundle.
- **Why it matters:** Navigation files are typically human-readable tables of contents excluded from skill bundles. Linking to one creates a dead reference inside the packaged output. Agents following the link at runtime find nothing useful.
- **Fix:** Link to the specific content instead of the navigation file, or set `severity.LINK_TO_NAVIGATION_FILE` to `ignore` if this is intentional.

### `LINK_TO_GITIGNORED_FILE`

- **Default:** `error`
- **What:** Markdown link targets a gitignored file; risks leaking ignored data into the bundle.
- **Why it matters:** Gitignored files are typically excluded for a reason — generated artifacts, secrets, or local-only state. Bundling them could expose sensitive data or break portability for anyone cloning the repo.
- **Fix:** Link to a non-ignored file or adjust `.gitignore`. Allow the specific path via `validation.allow` if the risk has been reviewed.

### `LINK_MISSING_TARGET`

- **Default:** `error`
- **What:** Markdown link target does not exist on disk and is not a declared build artifact.
- **Why it matters:** Broken links in skill documentation mean agents hit dead ends when they follow references. This usually indicates a typo, a removed file, or a build-artifact path that needs declaring under `skills.config.<name>.files`.
- **Fix:** Fix the link path, create the file, or declare it under `skills.config.<name>.files` as a build artifact.

### `LINK_DEFERRED_ARTIFACT`

- **Default:** `info`
- **What:** Markdown link in `SKILL.md` targets a path that does not exist on disk but is declared as a build artifact under `skills.config.<name>.files`. VAT downgrades the [`LINK_MISSING_TARGET`](#link_missing_target) finding to this info notice and skips the [`LINK_TO_GITIGNORED_FILE`](#link_to_gitignored_file) check because the artifact has not been materialized yet at source time.
- **Why it matters:** Deferred artifacts are intentional: the file is generated by a build step declared in the `files:` config, so a broken-link error would be a false positive. The info notice keeps the situation visible without blocking the build.
- **Fix:** No action needed if the `files:` entry is correct and the artifact will be produced before distribution. To silence the notice, set `validation.severity.LINK_DEFERRED_ARTIFACT: ignore`.

### `LINK_TO_SKILL_DEFINITION`

- **Default:** `error`
- **What:** Markdown link targets another skill's `SKILL.md`; bundling it creates duplicate skill definitions.
- **Why it matters:** Each `SKILL.md` is a skill entry point. Including one skill's entry point inside another skill's bundle causes the agent framework to register the same skill twice, leading to unpredictable trigger behavior.
- **Fix:** Link to a specific resource inside the other skill, or reference the other skill by name.

### `LINK_BROKEN_FILE`

- **Default:** `error`
- **What:** A local file link points to a non-existent file.
- **Why it matters:** A broken local link is a dead reference — an agent or human following it lands on nothing. In a resources-path document this almost always means a typo, a renamed file, or a target that was deleted without updating the link. Distinct from the packaging-oriented [`LINK_MISSING_TARGET`](#link_missing_target): this fires in the `vat resources validate` path where build-artifact declarations do not apply.
- **Fix:** Fix the path or create the target file.

### `LINK_BROKEN_ANCHOR`

- **Default:** `error`
- **What:** An anchor link (`file.md#section` or in-page `#section`) points to a heading or id that does not exist in the target.
- **Why it matters:** Anchor drift silently breaks deep-links. The file resolves, so the link looks valid, but the reader lands at the top of the document instead of the cited section — the worst kind of broken link because it is invisible until followed.
- **Fix:** Fix the fragment to match an existing heading slug, or fix the target heading.

### `LINK_UNKNOWN`

- **Default:** `warning`
- **What:** A link could not be classified into any recognized link form (local file, anchor, external URL, mailto, etc.).
- **Why it matters:** An unclassifiable link usually indicates a malformed reference or an unsupported scheme. A warning (not an error) because the link engine cannot prove it is broken — only that it does not recognize the form. The markdown-link counterpart to the frontmatter [`frontmatter_unknown_link`](#frontmatter_unknown_link).
- **Fix:** Use a recognized link form.

### `LINK_TO_GITIGNORED`

- **Default:** `error`
- **What:** A tracked file links to a gitignored file.
- **Why it matters:** A committed document declaring a dependency on a gitignored target breaks portability — anyone cloning the repo gets the document but not the target. It also risks treating local-only or generated content as if it were part of the published artifact. Distinct from the skills-packaging code [`LINK_TO_GITIGNORED_FILE`](#link_to_gitignored_file), which guards against leaking ignored data into a *bundle*; this code fires in the `vat resources validate` path and the two coexist intentionally.
- **Fix:** Link a tracked target, or un-ignore the file in `.gitignore` if it should be committed.

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

## Packaging-Only Codes

*Stance: see [Packaging](./skill-quality-and-compatibility.md#packaging).*

Only meaningful when actually bundling a skill; fire from `vat skills build` (and its pre-flight in `vat skills validate`).

### `FILES_SOURCE_GITIGNORED`

- **Default:** `warning`
- **What:** A `files:` source path declared in the skill config resolves to a gitignored file. VAT will still copy it into the published bundle — this warning confirms the action and asks the author to verify it carries no secrets.
- **Why it matters:** Gitignored files are typically excluded from the repo for a reason (generated artifacts, local-only state, credentials). A `files:` entry that names a gitignored path will materialize that file into the bundle on any machine where the file exists, potentially leaking sensitive content to bundle consumers.
- **Fix:** Confirm the source file carries no secrets. If it is a known-safe build artifact (e.g. a bundled CLI from `dist/`), acknowledge it with a `validation.allow` entry that includes a `reason`:

  ```yaml
  validation:
    allow:
      FILES_SOURCE_GITIGNORED:
        - reason: "intentional built CLI from dist/ — no secrets"
  ```

  To change the default severity, use `validation.severity.FILES_SOURCE_GITIGNORED`. If the file may contain secrets, remove it from `files:` and generate the artifact from a non-ignored intermediate.
- **CI recommendation:** The `warning` default does not fail the build, so an *un-acknowledged* gitignored source still ships (with a warning printed) and `vat skills build` exits `0`. Teams that rely on this as a hard leak guard in CI should escalate it with `validation.severity.FILES_SOURCE_GITIGNORED: error`, forcing every gitignored source to be either removed or explicitly acknowledged via `validation.allow`.

### `LINK_DROPPED_BY_DEPTH`

- **Default:** `warning`
- **What:** Walker stopped following links at the configured `linkFollowDepth`; this link was not bundled.
- **Why it matters:** A depth-limited walk may silently omit content the skill author expected to be included. The agent gets a partial bundle without knowing it.
- **Fix:** Raise `linkFollowDepth`, bundle the file via `files` config, declare the drop intentional with `validation.allow`, or exclude via `excludeReferencesFromBundle.rules`.

### `PACKAGED_UNREFERENCED_FILE`

- **Default:** `error`
- **What:** File in the packaged output is not referenced from any packaged markdown.
- **Why it matters:** Unreferenced files bloat the bundle and indicate that content was added to the `files` config without wiring it into the skill's narrative. Agents never discover content that isn't linked.
- **Fix:** Add a markdown link or code-block mention in `SKILL.md` or a linked resource. Allow via `validation.allow` if the file is consumed programmatically.

### `PACKAGED_BROKEN_LINK`

- **Default:** `error`
- **What:** Link in the packaged output resolves to a file that is not present in the output (likely a link-rewriter bug).
- **Why it matters:** This code indicates VAT's own link rewriter produced an inconsistent bundle — a file was expected but wasn't written to the output. Unlike `LINK_MISSING_TARGET`, which flags source issues, this flags a post-build integrity failure.
- **Fix:** Report the issue — this indicates a VAT bug. As a temporary workaround, set `severity.PACKAGED_BROKEN_LINK` to `ignore` while the underlying bug is fixed.

## Resource Registry Codes

*Fire when building the resource registry — `vat resources validate` and any command that crawls resources.*

### `DUPLICATE_RESOURCE_ID`

- **Default:** `error`
- **What:** Two files resolve to the same resource id after path normalization (e.g. `My Guide.md` and `my-guide.md` both produce `my-guide-md`).
- **Why it matters:** Resource ids must be unique — a collision means one file silently shadows the other in lookups, link resolution, and bundling. This surfaces as a reported issue rather than aborting the whole run with an uncaught error.
- **Fix:** Rename one of the files so they produce distinct resource ids.

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
- **Fix:** Add explicit markdown links from SKILL.md (or a linked file) into the bundled subdirectories, or remove the unreferenced directory. Allow via `validation.allow` if the assets are consumed programmatically.

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
