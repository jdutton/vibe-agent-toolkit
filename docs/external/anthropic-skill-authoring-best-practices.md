# Anthropic Skill Authoring Best Practices — Cached

> **Source:** https://platform.claude.com/docs/en/docs/agents-and-tools/agent-skills/best-practices
> **Fetched:** 2026-04-18
> **Re-verified:** 2026-07-30 — live page diffed; no substantive drift, all numeric limits unchanged (name ≤64 chars, description ≤1,024 chars, SKILL.md <500 lines, TOC at >100 lines, references one level deep, three evaluations, Haiku/Sonnet/Opus).
> **License:** © Anthropic — reproduced here under fair-use for reference. Authoritative copy is the source URL; this cache exists so VAT's tooling stays diffable against Anthropic's guidance and we can catch divergence when Anthropic updates their doc.
>
> @vendor-claim reviewed=2026-07-30 verify=Re-fetch the Source URL above and diff it against this cache, then update this file, VALIDATION_THRESHOLDS, and packages/vat-development-agents/resources/skills/vat-skill-review.md together
>
> **Refresh policy:** Re-fetch when adopting a new Claude Code release that adds or changes Skills behavior, or every ~90 days, whichever is sooner. Preserve the "Fetched" date above, diff against the current live page, and update VAT's review rubric (`packages/vat-development-agents/resources/skills/vat-skill-review.md`) and this cache together so they stay aligned.

This cache captures the *load-bearing* portions of Anthropic's Skill authoring guidance — the parts VAT's `vat-skill-review` rubric either directly mirrors or takes an opinionated position against. See the source URL for the complete best-practices document and the [Skills overview](https://platform.claude.com/docs/en/docs/agents-and-tools/agent-skills/overview) for the architecture context.

## Frontmatter schema (required fields)

From Anthropic's overview and best-practices docs:

**`name`:**
- Maximum 64 characters
- Must contain only lowercase letters, numbers, and hyphens
- Cannot contain XML tags
- Cannot contain reserved words: "anthropic", "claude"

**`description`:**
- Must be non-empty
- Maximum 1024 characters
- Cannot contain XML tags
- Should describe what the Skill does and when to use it

## Naming: gerund form is preferred

Verbatim from best-practices:

> Use consistent naming patterns to make Skills easier to reference and discuss. Consider using **gerund form** (verb + -ing) for Skill names, as this clearly describes the activity or capability the Skill provides.

**Good examples (gerund form):** `processing-pdfs`, `analyzing-spreadsheets`, `managing-databases`, `testing-code`, `writing-documentation`

**Acceptable alternatives:** noun phrases (`pdf-processing`), action-oriented (`process-pdfs`)

**Avoid:** vague names (`helper`, `utils`, `tools`), overly generic (`documents`, `data`), reserved words (`anthropic-helper`, `claude-tools`), inconsistent patterns within a collection.

## Descriptions: third person, specific, with when-to-use

Verbatim warning from best-practices:

> **Always write in third person**. The description is injected into the system prompt, and inconsistent point-of-view can cause discovery problems.
>
> - **Good:** "Processes Excel files and generates reports"
> - **Avoid:** "I can help you process Excel files"
> - **Avoid:** "You can use this to process Excel files"

Verbatim best-practices note:

> **Be specific and include key terms**. Include both what the Skill does and specific triggers/contexts for when to use it.

Verbatim rationale for why the description carries so much weight — note that it is *selection among many skills*, not truncation:

> Each Skill has exactly one description field. The description is critical for skill selection: Claude uses it to choose the right Skill from potentially 100+ available Skills. Your description must provide enough detail for Claude to know when to select this Skill, while the rest of SKILL.md provides the implementation details.

### Effective description examples (verbatim)

```yaml
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

```yaml
description: Analyze Excel spreadsheets, create pivot tables, generate charts. Use when analyzing Excel files, spreadsheets, tabular data, or .xlsx files.
```

```yaml
description: Generate descriptive commit messages by analyzing git diffs. Use when the user asks for help writing commit messages or reviewing staged changes.
```

### Bad descriptions Anthropic flags

Verbatim:

```yaml
description: Helps with documents
description: Processes data
description: Does stuff with files
```

These are bad because they are vague — not because of their opening phrases.

## What Anthropic does *not* ban explicitly

For VAT's reference when deciding which checklist items are Anthropic-aligned vs VAT-opinionated:

- Anthropic does **not** ban `This skill...`, `A skill that...`, `Used to...` as opening phrases. They do not use them in examples either, but there is no explicit prohibition.
- Anthropic does **not** cite the 250-character Claude Code truncation limit in their best-practices document (the 1024 limit is the schema hard max).
- Anthropic does **not** say Claude *truncates* descriptions at all. The stated reason to front-load key terms is selection pressure across "potentially 100+ available Skills," not a cut-off. Any VAT text that argues from truncation is arguing from VAT's own reading of the Claude Code `/skills` listing, and must be labelled `[VAT]`.
- Anthropic **does** contradict VAT's `MAX_REFERENCE_DEPTH: 2`. Their rule is "one level deep," and their "Bad example: Too deep" is exactly `SKILL.md → advanced.md → details.md` — the chain VAT's `REFERENCE_TOO_DEEP` example calls "2 hops, OK."
- Anthropic **does** recommend `Use when <concrete trigger>` — every effective example in their doc uses it after a verb phrase.

VAT's checklist may be stricter than Anthropic's explicit position. When that happens, the checklist should mark the item as a VAT opinion, not imply it's Anthropic guidance.

## Body size guidance

Verbatim from best-practices:

> Keep SKILL.md body under 500 lines for optimal performance. If your content exceeds this, split it into separate files using the progressive disclosure patterns described earlier.

## Progressive disclosure patterns

Anthropic recommends three patterns:

1. **High-level guide with references** — SKILL.md is the overview; specialized content lives in sibling markdown files loaded on demand.
2. **Domain-specific organization** — split reference content by domain (e.g., `reference/finance.md`, `reference/sales.md`) so Claude only loads what a specific task needs.
3. **Conditional details** — inline basic content, link to advanced.

Verbatim guidance on nesting:

> **Keep references one level deep from SKILL.md**. All reference files should link directly from SKILL.md to ensure Claude reads complete files when needed.

Verbatim guidance on reference-file tables of contents:

> For reference files longer than 100 lines, include a table of contents at the top. This ensures Claude can see the full scope of available information even when previewing with partial reads.

## Content guidelines

### Avoid time-sensitive information

Verbatim:

> Don't include information that will become outdated.

Bad example Anthropic cites:

```markdown
If you're doing this before August 2025, use the old API.
After August 2025, use the new API.
```

Recommended pattern: move deprecated guidance into a clearly labeled "Old patterns" `<details>` section.

### Use consistent terminology

Verbatim:

> Choose one term and use it throughout the Skill.
>
> **Bad:** Mix "API endpoint", "URL", "API route", "path"

## Runtime environment: filesystem, file naming, and bundle size

Verbatim from the "Runtime environment" section — the numbered list of how Claude reaches a skill's files:

> 3. **Scripts executed efficiently:** Utility scripts can be executed through bash without loading their full contents into context. Only the script's output consumes tokens
> 4. **No context penalty for large files:** Reference files, data, or documentation don't consume context tokens until actually read

Verbatim from the authoring bullets in the same section:

> - **File paths matter:** Claude navigates your skill directory like a filesystem. Use forward slashes (`reference/guide.md`), not backslashes
> - **Name files descriptively:** Use names that indicate content: `form_validation_rules.md`, not `doc2.md`
> - **Organize for discovery:** Structure directories by domain or feature
>   - Good: `reference/finance.md`, `reference/sales.md`
>   - Bad: `docs/file1.md`, `docs/file2.md`
> - **Bundle comprehensive resources:** Include complete API docs, extensive examples, large datasets; no context penalty until accessed

**Why this is load-bearing for VAT:** "Bundle comprehensive resources … no context penalty until accessed" is a *counter-signal* to VAT's `SKILL_TOTAL_SIZE_LARGE` (`MAX_TOTAL_LINES: 2000`) and `SKILL_TOO_MANY_FILES` (`MAX_FILE_COUNT: 6`). Anthropic's stated position is that unread bundled content is free; VAT's position is that a large bundle is a maintainability and reviewability signal worth a warning. Both thresholds are VAT-originated and are *not* traceable to this document — see the provenance comment above `VALIDATION_THRESHOLDS` in `packages/agent-skills/src/validators/validation-rules.ts`.

Anthropic's own `pdf/` directory example in the progressive-disclosure section ships **seven** files:

```text
pdf/
├── SKILL.md              # Main instructions (loaded when triggered)
├── FORMS.md              # Form-filling guide (loaded as needed)
├── reference.md          # API reference (loaded as needed)
├── examples.md           # Usage examples (loaded as needed)
└── scripts/
    ├── analyze_form.py   # Utility script (executed, not loaded)
    ├── fill_form.py      # Form filling script
    └── validate.py       # Validation script
```

That falsifies any claim that "official skills use 1–5 files."

### Ignored content (vendor grounding for `PACKAGED_UNREFERENCED_FILE`)

Verbatim, from "Observe how Claude navigates Skills":

> - **Ignored content:** If Claude never accesses a bundled file, it might be unnecessary or poorly signaled in the main instructions

This is the closest vendor statement behind VAT's `PACKAGED_UNREFERENCED_FILE`. Note the framing difference: Anthropic treats an unread file as a *signal to investigate* ("might be unnecessary **or poorly signaled**"), not as a defect — which matches VAT's warning-not-error severity, and matches the remedy of adding a reference rather than deleting the file.

### Package dependencies differ by surface

Verbatim:

> Skills run in the code execution environment with platform-specific limitations:
>
> - **claude.ai:** Can install packages from npm and PyPI and pull from GitHub repositories
> - **Claude API:** Has no network access and no runtime package installation

A skill whose instructions say "run `pip install X` first" works on claude.ai and fails on the API. This is a surface-compatibility fact, not a style preference.

### Anti-pattern: Windows-style paths

Verbatim:

> Always use forward slashes in file paths, even on Windows:
>
> - ✓ **Good:** `scripts/helper.py`, `reference/guide.md`
> - ✗ **Avoid:** `scripts\helper.py`, `reference\guide.md`
>
> Unix-style paths work across all platforms, while Windows-style paths cause errors on Unix systems.

This is the vendor grounding for VAT's `WINDOWS_BACKSLASH_IN_PATH` (required, non-overridable).

### MCP tool references must be fully qualified

Verbatim:

> If your Skill uses MCP (Model Context Protocol) tools, always use fully qualified tool names to avoid "tool not found" errors.
>
> **Format:** `ServerName:tool_name`
>
> Where:
>
> - `BigQuery` and `GitHub` are MCP server names
> - `bigquery_schema` and `create_issue` are the tool names within those servers
>
> Without the server prefix, Claude may fail to locate the tool, especially when multiple MCP servers are available.

**Not covered anywhere in VAT** as of 2026-07-30 — no validation code, no rubric item until this refresh added a manual one. It is a shift-left candidate, not a shipped rule: promoting it would need corpus evidence per [`docs/validation-rule-design.md`](../validation-rule-design.md), because a bare tool name in a SKILL.md body is only a defect if the skill actually invokes MCP, and distinguishing "bare MCP tool name" from ordinary prose or a non-MCP identifier is exactly the kind of regex guess that produces false positives.

## Anthropic's own shorter checklist (verbatim, for diff against VAT's)

### Core quality
- Description is specific and includes key terms
- Description includes both what the Skill does and when to use it
- SKILL.md body is under 500 lines
- Additional details are in separate files (if needed)
- No time-sensitive information (or in "old patterns" section)
- Consistent terminology throughout
- Examples are concrete, not abstract
- File references are one level deep
- Progressive disclosure used appropriately
- Workflows have clear steps

### Code and scripts
- Scripts solve problems rather than defer to Claude
- Error handling is explicit and helpful
- No "voodoo constants" (all values justified)
- Required packages listed in instructions and verified as available
- Scripts have clear documentation
- No Windows-style paths (all forward slashes)
- Validation/verification steps for critical operations
- Feedback loops included for quality-critical tasks

### Testing
- At least three evaluations created
- Tested with Haiku, Sonnet, and Opus
- Tested with real usage scenarios
- Team feedback incorporated (if applicable)

## VAT-opinionated items (not in Anthropic's guidance)

Items VAT's checklist enforces that Anthropic does not explicitly call out — kept because they reflect adopter experience, empirical corpus observations, or Claude Code-specific behavior that post-dates the best-practices doc:

- Description ≤ 250 chars (Claude Code truncation, post-v2.1.86)
- No filler openers (`This skill...`, `A skill that...`, `Used to...`)
- Name matches built skill directory
- Cross-skill auth coupling must be explicit in the description when one skill delegates to another
- Frontmatter key conservatism (only `name`, `description`, `allowed-tools` — no project-specific keys)
- In-package consistency (sibling skills should use matching YAML styling)
- Large tables (>15 rows) should move to reference files

These are called out explicitly in the checklist preamble so adopters can distinguish them from Anthropic's rules.
