# VAT Validation Codes

This reference lists every overridable validation code VAT emits, plus the two meta-codes. Use it to interpret CLI output, configure `validation.severity` / `validation.allow`, and understand default behavior.

## Severity Model

- **`error`** — emit and **block** the build.
- **`warning`** — emit, do not block.
- **`ignore`** — do not emit (check still runs; result is discarded).
- **`info`** — structural reports (inventory, file counts); outside this framework, always emitted, never block.

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

## Source-Detectable Link Codes

Static-analysis codes that fire anywhere markdown is analyzed — `vat resources validate`, `vat skills validate`, `vat skills build`, `vat audit`.

### `LINK_OUTSIDE_PROJECT`

- **Default:** `error`
- **What:** Markdown link points to a file outside the project root.
- **Why it matters:** Skills and resource bundles are self-contained artifacts. A link that escapes the project root cannot be resolved by the agent at runtime and signals a structural problem in how the content is organized.
- **Fix:** Move the target inside the project or remove the link. Use `validation.allow` if the reference is intentional and cross-project.

### `LINK_TARGETS_DIRECTORY`

- **Default:** `error`
- **What:** Markdown link resolves to a directory rather than a file.
- **Why it matters:** Directory links are ambiguous — agents and renderers cannot load a directory as content. The author almost certainly intended a specific file inside it.
- **Fix:** Point the link at a specific file (e.g. `README.md` inside the directory) instead of the directory itself.

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

### `LINK_TO_SKILL_DEFINITION`

- **Default:** `error`
- **What:** Markdown link targets another skill's `SKILL.md`; bundling it creates duplicate skill definitions.
- **Why it matters:** Each `SKILL.md` is a skill entry point. Including one skill's entry point inside another skill's bundle causes the agent framework to register the same skill twice, leading to unpredictable trigger behavior.
- **Fix:** Link to a specific resource inside the other skill, or reference the other skill by name.

## Packaging-Only Codes

Only meaningful when actually bundling a skill; fire from `vat skills build` (and its pre-flight in `vat skills validate`).

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

## Quality Codes

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

## Compat Codes

Per-skill compatibility **smells** — patterns that signal a skill depends on a surface capability (browser, local shell, external CLI) that not every Claude runtime provides. Default severity is `warning`: these are advisory, not blocking, so adopters can surface them without breaking builds.

Compat smells are declarations more than suppressions. When a skill genuinely needs a capability, the right posture is usually to `validation.allow` the code with a `reason` that documents the intent. The smell's job is to make that requirement visible, not to grade the skill.

Scope in v1: detectors run against SKILL.md and its transitively linked markdown. Plugin-wide compat (hooks, `.mcp.json`) remains covered by the legacy `vat audit --compat` analyzer pending workstream B unification.

### `COMPAT_REQUIRES_BROWSER_AUTH`

- **Default:** `warning`
- **What:** Skill appears to require an interactive browser login flow (MSAL, cloud provider SSO, OAuth redirect).
- **Why it matters:** Surfaces without a browser — Claude Chat, Cowork, headless runtimes — cannot complete the login and the skill silently fails. Flagging the dependency lets authors declare it intentionally and lets runtimes route around incompatible skills.
- **Fix:** Document the requirement prominently. If a service-principal or bearer-token flow would work, prefer it to avoid the constraint. Otherwise allow via `validation.allow` with a reason explaining the intentional auth model.
- **When to allow:** The skill is intentionally interactive and documents Claude Code (or another browser-capable runtime) as its target surface. Allow with a reason citing the deliberate auth choice.

### `COMPAT_REQUIRES_LOCAL_SHELL`

- **Default:** `warning`
- **What:** Skill references a local-shell or local-environment tool (`Bash`/`Edit`/`Write`/`NotebookEdit`) or invokes a shell directly.
- **Why it matters:** Shell access and local filesystem mutation only exist on local runtimes like Claude Code. A skill that assumes shell availability will not run correctly on remote/chat surfaces.
- **Fix:** If the skill genuinely needs local access, document it and allow with a reason naming the dependency. If the shell is an implementation detail, refactor to use portable runtime APIs.
- **When to allow:** The skill is a Claude Code-only workflow (filesystem manipulation, CLI orchestration, IDE integration). Allow with a reason that names the local capability being relied on.

### `COMPAT_REQUIRES_EXTERNAL_CLI`

- **Default:** `warning`
- **What:** Skill invokes an external CLI binary not bundled with the skill (`az`, `aws`, `gcloud`, `kubectl`, `docker`, `terraform`, `gh`, `op`).
- **Why it matters:** External CLIs are environment-dependent — they may be installed, missing, or a different version on any given runtime. Making the dependency explicit lets users (or managed runtimes) ensure the binary is present before invoking the skill.
- **Fix:** Document the required CLI as a prerequisite in the skill description or README. Consider bundling a language-native SDK (e.g., `@azure/arm-*` instead of `az`) if portability matters. If the CLI is the right tool, allow with a reason.
- **When to allow:** The skill is intentionally a thin wrapper over a CLI and documents the dependency. Allow with a reason naming the CLI and the surface requirement.

## Meta Codes

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
