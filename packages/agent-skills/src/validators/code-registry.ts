/**
 * Canonical code registry.
 *
 * Single source of truth for every overridable validation code VAT emits.
 * Describes default severity, human description, fix hint, and a stable
 * reference anchor into docs/validation-codes.md.
 *
 * Renderers (CLI help, skill docs, runtime output) all pull from this
 * registry — no duplication.
 */

export type IssueSeverity = 'error' | 'warning' | 'info' | 'ignore';

/** Non-ignore severities actually emitted to consumers. */
export type EmittedSeverity = Exclude<IssueSeverity, 'ignore'>;

export type IssueCode =
  // Source-detectable link codes
  | 'LINK_OUTSIDE_PROJECT'
  | 'LINK_TARGETS_DIRECTORY'
  | 'LINK_TO_NAVIGATION_FILE'
  | 'LINK_TO_GITIGNORED_FILE'
  | 'LINK_MISSING_TARGET'
  | 'LINK_TO_SKILL_DEFINITION'
  // Packaging-only link / output codes
  | 'LINK_DROPPED_BY_DEPTH'
  | 'PACKAGED_UNREFERENCED_FILE'
  | 'PACKAGED_BROKEN_LINK'
  // Best-practice / quality codes
  | 'SKILL_LENGTH_EXCEEDS_RECOMMENDED'
  | 'SKILL_TOTAL_SIZE_LARGE'
  | 'SKILL_TOO_MANY_FILES'
  | 'REFERENCE_TOO_DEEP'
  | 'DESCRIPTION_TOO_VAGUE'
  | 'NO_PROGRESSIVE_DISCLOSURE'
  | 'SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT'
  | 'SKILL_DESCRIPTION_FILLER_OPENER'
  | 'SKILL_DESCRIPTION_WRONG_PERSON'
  | 'SKILL_CLAUDE_PLUGIN_NAME_MISMATCH'
  | 'SKILL_NAME_MISMATCHES_DIR'
  | 'RESERVED_WORD_IN_NAME'
  | 'SKILL_TIME_SENSITIVE_CONTENT'
  | 'SKILL_FRONTMATTER_EXTRA_FIELDS'
  | 'SKILL_CROSS_SKILL_AUTH_UNDECLARED'
  | 'SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE'
  // Plugin manifest recommended fields (cross-walk from plugin-dev)
  | 'PLUGIN_MISSING_DESCRIPTION'
  | 'PLUGIN_MISSING_AUTHOR'
  | 'PLUGIN_MISSING_LICENSE'
  // Naming convention codes — named promotion of generic schema errors
  | 'PLUGIN_NAME_NOT_KEBAB_CASE'
  | 'SKILL_NAME_NOT_KEBAB_CASE'
  // Skill body / packaging quality
  | 'SKILL_REFERENCES_BUT_NO_LINKS'
  | 'SKILL_BODY_NOT_IMPERATIVE'
  // Capability observations — what a skill requires from its runtime
  | 'CAPABILITY_LOCAL_SHELL'
  | 'CAPABILITY_EXTERNAL_CLI'
  | 'CAPABILITY_BROWSER_AUTH'
  // Compat verdicts — emitted when declared target does not cover required capability
  | 'COMPAT_TARGET_INCOMPATIBLE'
  | 'COMPAT_TARGET_NEEDS_REVIEW'
  | 'COMPAT_TARGET_UNDECLARED'
  // Meta-codes describing the state of the validation config itself
  | 'ALLOW_EXPIRED'
  | 'ALLOW_UNUSED'
  // Inventory / structural codes
  | 'COMPONENT_DECLARED_BUT_MISSING'
  | 'COMPONENT_PRESENT_BUT_UNDECLARED'
  | 'REFERENCE_TARGET_MISSING'
  | 'MARKETPLACE_PLUGIN_SOURCE_MISSING';

export interface CodeRegistryEntry {
  defaultSeverity: EmittedSeverity;
  description: string;
  fix: string;
  /** Stable anchor into docs/validation-codes.md (e.g. '#link_outside_project'). */
  reference: string;
}

const entry = (
  defaultSeverity: EmittedSeverity,
  description: string,
  fix: string,
  anchor: string,
): CodeRegistryEntry => ({ defaultSeverity, description, fix, reference: `#${anchor}` });

export const CODE_REGISTRY: Record<IssueCode, CodeRegistryEntry> = {
  LINK_OUTSIDE_PROJECT: entry(
    'error',
    'Markdown link points to a file outside the project root.',
    'Move the target inside the project or remove the link. Use validation.allow if the reference is intentional and cross-project.',
    'link_outside_project',
  ),
  LINK_TARGETS_DIRECTORY: entry(
    'error',
    'Markdown link resolves to a directory rather than a file.',
    'Point the link at a specific file (e.g. README.md inside the directory) instead of the directory itself.',
    'link_targets_directory',
  ),
  LINK_TO_NAVIGATION_FILE: entry(
    'warning',
    'Markdown link targets a navigation file (README.md, index.md, etc.) which was excluded from the bundle.',
    'Link to the specific content instead of the navigation file, or set severity.LINK_TO_NAVIGATION_FILE to ignore if this is intentional.',
    'link_to_navigation_file',
  ),
  LINK_TO_GITIGNORED_FILE: entry(
    'error',
    'Markdown link targets a gitignored file; risks leaking ignored data into the bundle.',
    'Link to a non-ignored file or adjust .gitignore. Allow the specific path via validation.allow if the risk has been reviewed.',
    'link_to_gitignored_file',
  ),
  LINK_MISSING_TARGET: entry(
    'error',
    'Markdown link target does not exist on disk and is not a declared build artifact.',
    'Fix the link path, create the file, or declare it under skills.config.<name>.files as a build artifact.',
    'link_missing_target',
  ),
  LINK_TO_SKILL_DEFINITION: entry(
    'error',
    "Markdown link targets another skill's SKILL.md; bundling it creates duplicate skill definitions.",
    'Link to a specific resource inside the other skill, or reference the other skill by name.',
    'link_to_skill_definition',
  ),
  LINK_DROPPED_BY_DEPTH: entry(
    'warning',
    'Walker stopped following links at the configured linkFollowDepth; this link was not bundled.',
    'Raise linkFollowDepth, bundle the file via files config, declare the drop intentional with validation.allow, or exclude via excludeReferencesFromBundle.rules.',
    'link_dropped_by_depth',
  ),
  PACKAGED_UNREFERENCED_FILE: entry(
    'error',
    'File in the packaged output is not referenced from any packaged markdown.',
    'Add a markdown link or code-block mention in SKILL.md or a linked resource. Allow via validation.allow if the file is consumed programmatically.',
    'packaged_unreferenced_file',
  ),
  PACKAGED_BROKEN_LINK: entry(
    'error',
    'Link in the packaged output resolves to a file that is not present in the output (likely a link-rewriter bug).',
    'Report the issue — this indicates a VAT bug. As a temporary workaround, set severity.PACKAGED_BROKEN_LINK to ignore while the underlying bug is fixed.',
    'packaged_broken_link',
  ),
  SKILL_LENGTH_EXCEEDS_RECOMMENDED: entry(
    'warning',
    'SKILL.md line count exceeds the recommended limit; longer files degrade skill triggering.',
    'Split content into linked resources (progressive disclosure) or allow if the length is justified.',
    'skill_length_exceeds_recommended',
  ),
  SKILL_TOTAL_SIZE_LARGE: entry(
    'warning',
    'Total packaged line count exceeds the recommended limit.',
    'Reduce bundled content, move references out of the bundle, or allow if the size is justified.',
    'skill_total_size_large',
  ),
  SKILL_TOO_MANY_FILES: entry(
    'warning',
    'Packaged file count exceeds the recommended limit.',
    'Consolidate or restructure references, or allow if the file count is justified.',
    'skill_too_many_files',
  ),
  REFERENCE_TOO_DEEP: entry(
    'warning',
    'Bundled link graph exceeds the recommended depth; deeply nested references hurt discoverability.',
    'Flatten the reference structure or allow if depth is intentional.',
    'reference_too_deep',
  ),
  DESCRIPTION_TOO_VAGUE: entry(
    'warning',
    'SKILL.md description is too short to reliably trigger the skill.',
    'Expand the description with concrete triggers and use cases.',
    'description_too_vague',
  ),
  NO_PROGRESSIVE_DISCLOSURE: entry(
    'warning',
    'Long SKILL.md with no linked references; progressive disclosure recommended.',
    'Move background detail into linked resources and reference them from SKILL.md.',
    'no_progressive_disclosure',
  ),
  SKILL_DESCRIPTION_OVER_CLAUDE_CODE_LIMIT: entry(
    'warning',
    'SKILL.md description exceeds the 250-character Claude Code /skills display limit.',
    'Shorten the description below 250 chars (target ≤200 for a safety margin, or ≤130 if shipping a large skill collection).',
    'skill_description_over_claude_code_limit',
  ),
  SKILL_DESCRIPTION_FILLER_OPENER: entry(
    'warning',
    'SKILL.md description opens with meta-filler (e.g., "This skill...", "A skill that...", "Use when you want to...").',
    'Lead with a verb phrase ("Extracts text from PDFs...") or "Use when <concrete trigger>".',
    'skill_description_filler_opener',
  ),
  SKILL_DESCRIPTION_WRONG_PERSON: entry(
    'warning',
    'SKILL.md description uses first-person or conversational second-person voice.',
    'Rewrite in third person. "I can extract PDFs" → "Extracts text from PDFs". "You can use this to..." → the action itself.',
    'skill_description_wrong_person',
  ),
  SKILL_CLAUDE_PLUGIN_NAME_MISMATCH: entry(
    'warning',
    'plugin.json name does not match the co-located root SKILL.md frontmatter name.',
    'Align the names: update plugin.json `name` to match SKILL.md `name` (the skill is authoritative), or intentionally namespace the plugin (configure `validation.severity` or `validation.allow` with a reason).',
    'skill_claude_plugin_name_mismatch',
  ),
  SKILL_NAME_MISMATCHES_DIR: entry(
    'warning',
    'Frontmatter name field does not match the skill parent directory name.',
    'Align them: rename the directory to match name, or update name to match the directory.',
    'skill_name_mismatches_dir',
  ),
  RESERVED_WORD_IN_NAME: entry(
    'warning',
    'Frontmatter `name` contains a reserved word (`anthropic` or `claude`); Claude Code rejects non-certified skills using these words.',
    'Rename the skill to avoid `anthropic` or `claude` in the name.',
    'reserved_word_in_name',
  ),
  SKILL_TIME_SENSITIVE_CONTENT: entry(
    'info',
    'SKILL.md body contains time-sensitive prose (e.g., "as of November 2025") that may become stale.',
    'Remove the time qualifier, or move deprecated guidance into a clearly labeled "## Old patterns" section with a <details> block.',
    'skill_time_sensitive_content',
  ),
  SKILL_FRONTMATTER_EXTRA_FIELDS: entry(
    'warning',
    'SKILL.md frontmatter contains a field outside the standard agentskills.io + Claude Code key set.',
    'Move custom data under `metadata.<key>`, or remove the field. Per-project config belongs in vibe-agent-toolkit.config.yaml, not SKILL.md frontmatter.',
    'skill_frontmatter_extra_fields',
  ),
  SKILL_CROSS_SKILL_AUTH_UNDECLARED: entry(
    'warning',
    'SKILL.md body declares a dependency on a sibling skill or ANTHROPIC_*_KEY environment variable that is not mentioned in the description.',
    'Name the dependency in the description (e.g. "Requires ado skill for auth" or "Requires ANTHROPIC_ADMIN_API_KEY") so agents loading the skill discover it without reading the body.',
    'skill_cross_skill_auth_undeclared',
  ),
  SKILL_DESCRIPTION_STYLE_MIXED_IN_PACKAGE: entry(
    'warning',
    'Sibling skills in the same package use mixed YAML scalar styles for their `description` frontmatter (e.g., folded `>-` alongside inline double-quoted).',
    'Pick one YAML style and apply it to every skill in the package.',
    'skill_description_style_mixed_in_package',
  ),
  PLUGIN_MISSING_DESCRIPTION: entry(
    'info',
    'plugin.json is missing the recommended `description` field.',
    'Add a "description" field to plugin.json so users see what the plugin does in the listing.',
    'plugin_missing_description',
  ),
  PLUGIN_MISSING_AUTHOR: entry(
    'info',
    'plugin.json is missing the recommended `author` field.',
    'Add an "author" object (e.g. { "name": "..." }) to plugin.json so downstream consumers can attribute the plugin.',
    'plugin_missing_author',
  ),
  PLUGIN_MISSING_LICENSE: entry(
    'info',
    'plugin.json is missing the recommended `license` field.',
    'Add a "license" SPDX identifier (e.g. "MIT") to plugin.json so redistribution terms are explicit.',
    'plugin_missing_license',
  ),
  PLUGIN_NAME_NOT_KEBAB_CASE: entry(
    'info',
    'Plugin name does not match the kebab-case convention required by Claude Code (lowercase alphanumeric with single hyphens).',
    'Rename the plugin to kebab-case (e.g. "my-plugin"). Schema parse already errors; this code surfaces the same finding with a more actionable message.',
    'plugin_name_not_kebab_case',
  ),
  SKILL_NAME_NOT_KEBAB_CASE: entry(
    'info',
    'Skill frontmatter `name` does not match the kebab-case convention.',
    'Rename the skill to kebab-case (e.g. "my-skill"). Schema parse already errors; this code surfaces the same finding with a more actionable message.',
    'skill_name_not_kebab_case',
  ),
  SKILL_REFERENCES_BUT_NO_LINKS: entry(
    'info',
    'Skill directory contains scripts/, references/, or assets/ subdirectories but the SKILL.md body has zero markdown links into them.',
    'Add explicit markdown links from SKILL.md (or a linked file) into the bundled subdirectories, or remove the unreferenced directory. Allow via validation.allow if the assets are consumed programmatically.',
    'skill_references_but_no_links',
  ),
  SKILL_BODY_NOT_IMPERATIVE: entry(
    'info',
    'SKILL.md body contains second-person instructional openers (e.g. "You should…", "You need to…", "You can…").',
    'Rewrite as imperative ("Configure the MCP server…" instead of "You should configure…"). Skill bodies read more cleanly as instructions to the agent rather than to a human reader. Allow via validation.allow if the heuristic misfires on quoted prompts or user dialog.',
    'skill_body_not_imperative',
  ),
  CAPABILITY_LOCAL_SHELL: entry(
    'info',
    'Skill references a local-shell tool (Bash/Edit/Write/NotebookEdit) or invokes a shell.',
    'Informational. Declare a plugin target that provides shell (claude-code, claude-cowork) so this observation resolves to an expected verdict.',
    'capability_local_shell',
  ),
  CAPABILITY_EXTERNAL_CLI: entry(
    'info',
    'Skill invokes an external CLI binary not bundled with the skill.',
    'Informational. Ensure the declared target guarantees the binary or document the prerequisite.',
    'capability_external_cli',
  ),
  CAPABILITY_BROWSER_AUTH: entry(
    'info',
    'Skill appears to require an interactive browser login flow.',
    'Informational. If a service-principal flow would work, prefer it. Otherwise declare a browser-capable target.',
    'capability_browser_auth',
  ),
  COMPAT_TARGET_INCOMPATIBLE: entry(
    'warning',
    "Skill's declared target runtime definitively lacks a required capability.",
    'Narrow the declared target to runtimes that support the capability, or allow with a reason.',
    'compat_target_incompatible',
  ),
  COMPAT_TARGET_NEEDS_REVIEW: entry(
    'warning',
    "Declared target's capability profile covers the axis but a specific resource is uncertain.",
    'Document the prerequisite or allow with a reason.',
    'compat_target_needs_review',
  ),
  COMPAT_TARGET_UNDECLARED: entry(
    'info',
    'Skill has capability observations but no target is declared.',
    'Declare targets in vibe-agent-toolkit.config.yaml, plugin.json, or marketplace.json defaults.',
    'compat_target_undeclared',
  ),
  ALLOW_EXPIRED: entry(
    'warning',
    "A validation.allow entry's expires date is in the past; the allowance still applies but should be re-reviewed.",
    'Re-review the allow entry: extend expires, remove the entry, or fix the underlying issue. Upgrade severity to error for zero-tolerance expiry.',
    'allow_expired',
  ),
  ALLOW_UNUSED: entry(
    'warning',
    'A validation.allow entry did not match any emitted issue; the allow entry is dead weight.',
    'Remove the entry or fix the pattern. Upgrade severity to error to block on unused allow entries.',
    'allow_unused',
  ),
  COMPONENT_DECLARED_BUT_MISSING: entry(
    'warning',
    'A component path declared in the plugin manifest does not exist on disk.',
    'Add the missing file, remove the manifest declaration, or correct the path. Use validation.allow if the artifact is generated by an install-time build step.',
    'component_declared_but_missing',
  ),
  COMPONENT_PRESENT_BUT_UNDECLARED: entry(
    'info',
    'A component is present under the canonical layout but the manifest declares an explicit list that omits it; the runtime may silently skip it at install.',
    'Add the component to the appropriate manifest field, or remove the file if unintended. Skipped when the manifest omits the field entirely (auto-discovery is intentional).',
    'component_present_but_undeclared',
  ),
  REFERENCE_TARGET_MISSING: entry(
    'error',
    'A cross-component reference resolved from the manifest points to a path that does not exist.',
    'Add the referenced file or correct the path in the manifest.',
    'reference_target_missing',
  ),
  MARKETPLACE_PLUGIN_SOURCE_MISSING: entry(
    'error',
    'A marketplace declares a plugin with a path-based source that does not exist.',
    'Correct the source path or remove the entry from marketplace.plugins[].',
    'marketplace_plugin_source_missing',
  ),
};
