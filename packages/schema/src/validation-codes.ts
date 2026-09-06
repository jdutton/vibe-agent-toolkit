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

import { z } from 'zod';

export type IssueSeverity = 'error' | 'warning' | 'info' | 'ignore';

/** Non-ignore severities actually emitted to consumers. */
export type EmittedSeverity = Exclude<IssueSeverity, 'ignore'>;

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

export const CODE_REGISTRY = {
  LINK_OUTSIDE_PROJECT: entry(
    'error',
    'Markdown link points to a file outside the project root.',
    'Move the target inside the project or remove the link. Use validation.allow if the reference is intentional and cross-project.',
    'link_outside_project',
  ),
  LINK_TARGETS_DIRECTORY: entry(
    'error',
    'A typed single-file reference (e.g. a packaging `files:` source entry) resolves to a directory instead of a file.',
    'Point the `files:` source (or other single-file reference) at a specific file, not a directory. Navigational prose links to a directory are valid and do not trigger this code.',
    'link_targets_directory',
  ),
  // The prose-link sibling of LINK_TARGETS_DIRECTORY, and deliberately NOT that
  // code. The walker classifies a link resolving to a directory as
  // `directory-target`, and until now that classification reached no code at all:
  // the verdict engine returned `null` for a non-typed-slot directory and the
  // issue lane filtered it out, so an author whose link pointed at a directory
  // got the directory dropped from the bundle and no finding of any kind.
  //
  // Reusing LINK_TARGETS_DIRECTORY was not available: its own `fix` says in as
  // many words that navigational prose links to a directory do not trigger it,
  // so emitting it here would hand a reader a finding that denies its own
  // applicability — and its `error` default would fail exactly the builds #126
  // (decision record D7) decided to allow.
  //
  // `warning`, which is the severity this family already uses for "the target is
  // legitimate at source, but it did not travel, so the packaged link points at
  // nothing" — LINK_TO_NAVIGATION_FILE and LINK_FROM_NON_ROUTABLE_FILE are the
  // same shape and both warn. `error` is reserved here for edges that cannot be
  // right at source (outside the project, a leak, a missing target); a directory
  // link resolves perfectly well for a reader browsing the repo, which is why
  // the report is about packaging, not about the link being malformed.
  LINK_TO_UNBUNDLED_DIRECTORY: entry(
    'warning',
    'Markdown link targets a directory; directories are never bundled, so the target did not ship and the packaged link points at nothing.',
    // Deliberately does NOT offer "point it at the directory's README.md": VAT
    // does not resolve a directory to an index file (decision record D7), so
    // advice phrased as if it did would describe a mechanism that is not there.
    'Link the specific file inside the directory that the prose means — a directory cannot be packaged, and VAT does not resolve one to an index file. Set severity.LINK_TO_UNBUNDLED_DIRECTORY to ignore if the link is meant for a reader browsing the repository rather than for the packaged bundle.',
    'link_to_unbundled_directory',
  ),
  LINK_TO_NAVIGATION_FILE: entry(
    'warning',
    'Markdown link targets a navigation file (README.md, index.md, etc.) which was excluded from the bundle.',
    'Link to the specific content instead of the navigation file, or set severity.LINK_TO_NAVIGATION_FILE to ignore if this is intentional.',
    'link_to_navigation_file',
  ),
  LINK_TO_AGENT_INSTRUCTION_FILE: entry(
    'error',
    // "excluded from the bundle" used to be asserted unconditionally, and it was
    // FALSE in the one configuration the fix string recommended: with an explicit
    // files: entry naming the file, the file shipped. The description now states
    // the precondition that makes it true, and names the consequence the old
    // wording left silent — the link is stripped, so the packaged prose points at
    // nothing.
    'Markdown link targets a repo-internal agent-instruction file (CLAUDE.md, AGENTS.md, GEMINI.md) that no explicit files: entry declares; it is not bundled and the link is stripped from the packaged content.',
    // Three real remedies, then the declaration route. The absolute-URL route is
    // listed because it is the cheapest correct fix for the dominant population —
    // links that point UPWARD out of the skill dir at a file whose canonical home
    // is a repository the reader can open.
    //
    // The declaration route is stated as EXPLICIT (non-glob) deliberately: it used
    // to read "declare it under skills.config.<name>.files" and doing exactly that
    // changed nothing, because the walker refused the link whatever the config
    // said. The remedy told you to do the thing you had already done. It is now
    // honoured, and the qualifier is load-bearing — a glob is a net, not a
    // declaration, and never packages one of these files.
    "Link the specific content the file describes; point the link at the file's canonical home as an absolute URL; or extract the shared part into a document intended for distribution. To ship the file deliberately, name it in an explicit (non-glob) skills.config.<name>.files entry — the file is then bundled and this link is rewritten to the declared dest.",
    'link_to_agent_instruction_file',
  ),
  LINK_TO_GITIGNORED_FILE: entry(
    'error',
    'Markdown link targets a gitignored file; risks leaking ignored data into the bundle.',
    'Link to a non-ignored file or adjust .gitignore. Allow the specific path via validation.allow if the risk has been reviewed. If the target is a build artifact, declare it under skills.config.<name>.files instead.',
    'link_to_gitignored_file',
  ),
  LINK_MISSING_TARGET: entry(
    'error',
    'Markdown link target does not exist on disk and is not a declared build artifact.',
    'Fix the link path, create the file, or declare it under skills.config.<name>.files as a build artifact.',
    'link_missing_target',
  ),
  LINK_TARGET_UNREADABLE: entry(
    'error',
    'Markdown link target exists on disk but could not be read, so it was neither classified nor bundled. Most often permissions; also a change racing the walk.',
    'Fix the permissions on the target, or investigate what changed it mid-walk, then re-run. Set severity.LINK_TARGET_UNREADABLE to warning if a corpus is expected to contain entries the walk cannot read.',
    'link_target_unreadable',
  ),
  LINK_DEFERRED_ARTIFACT: entry(
    'info',
    'Link targets a deferred build artifact declared in the skill files: config; it will exist after the build materializes it.',
    'No action needed if the files: entry is correct. To silence, set validation.severity.LINK_DEFERRED_ARTIFACT: ignore.',
    'link_deferred_artifact',
  ),
  LINK_TO_SKILL_DEFINITION: entry(
    'error',
    "Markdown link targets another skill's SKILL.md; bundling it creates duplicate skill definitions.",
    'Link to a specific resource inside the other skill, or reference the other skill by name.',
    'link_to_skill_definition',
  ),
  LINK_FROM_NON_ROUTABLE_FILE: entry(
    'warning',
    // States the mechanism, because the author cannot infer it: the referring
    // file WAS bundled, which makes the missing target look like a rewriter bug
    // rather than a deliberate routing boundary.
    'A bundled non-routable file (HTML) links to a file the walker did not follow, so the target is not in the bundle and the packaged link points at nothing.',
    'Link the target from a markdown file in the bundle, declare it under skills.config.<name>.files, or set severity.LINK_FROM_NON_ROUTABLE_FILE to ignore if the packaged link is meant to resolve outside the bundle.',
    'link_from_non_routable_file',
  ),
  LINK_DROPPED_BY_DEPTH: entry(
    'warning',
    'Walker stopped following links at the configured linkFollowDepth; this link was not bundled.',
    'Raise linkFollowDepth, bundle the file via files config, declare the drop intentional with validation.allow, or exclude via excludeReferencesFromBundle.rules.',
    'link_dropped_by_depth',
  ),
  // The receipt for an exclusion the author asked for. Its sibling
  // LINK_DROPPED_BY_DEPTH reports a drop the author configured a NUMBER for and
  // may not have meant; this one reports a drop they wrote a PATTERN for and
  // almost certainly did. That is the whole severity argument.
  //
  // `info`, not `warning`: warning-level noise on a working configuration is how
  // a report gets ignored, and every `excludeReferencesFromBundle` rule fires on
  // every build by design. But silence was worse — the lane emitted nothing at
  // all, so an author asking "why did this file not ship?" got no answer from
  // the tool that knew. `info` is the posture this registry already uses for
  // "true, and only interesting when you are looking" (LINK_DEFERRED_ARTIFACT,
  // FILES_GLOB_MATCHED_NOTHING).
  //
  // The per-issue message names the patterns that matched, supplied by the
  // emitting lane from the walker's own `matchedRule` record — with several
  // rules configured, knowing that one of them fired is not an answer.
  LINK_EXCLUDED_BY_PATTERN: entry(
    'info',
    'A reference was excluded from the bundle by an excludeReferencesFromBundle rule this project declared; the target did not ship.',
    'No action needed if the exclusion is intended — the rule did exactly what it was configured to do. If the target should have shipped, narrow or remove the matching excludeReferencesFromBundle rule, or declare the file under skills.config.<name>.files. Set severity.LINK_EXCLUDED_BY_PATTERN to ignore to drop these from the report entirely.',
    'link_excluded_by_pattern',
  ),
  PACKAGED_UNREFERENCED_FILE: entry(
    'error',
    'File in the packaged output is not referenced from any packaged markdown.',
    'Add a markdown link or code-block mention in SKILL.md or a linked resource. A file consumed programmatically belongs in skills.config.<name>.files as a source/dest pair — a declared dest is exempt, so do NOT restate it in validation.allow.',
    'packaged_unreferenced_file',
  ),
  // The exact inverse of PACKAGED_UNREFERENCED_FILE: that code asks "is every
  // shipped file mentioned?", this one asks "is every mentioned path shipped?".
  // Same substrate, opposite direction — and only this direction catches a
  // BUILD DROP, where the file is correct in the source repo and absent from
  // dist. No human review of the source can see that, which is why it is worth
  // a code despite the narrower precision.
  //
  // Warning, not error, on measured evidence: 1 misfire in 52 built adopter
  // skills, and the residual class is irreducible — a skill whose SUBJECT is
  // skill authoring cites example paths it does not ship. VAT's own
  // vat-skill-authoring is in that class.
  PACKAGED_REFERENCED_PATH_MISSING: entry(
    'warning',
    'SKILL.md (or a bundled reference file) names a path under a bundled subdirectory that is not present in the packaged output.',
    'Ship the file, correct the path, or — if the token is an illustrative example rather than a real reference — reword it so it is not a bare bundled-subdirectory path. A file injected at build time belongs in skills.config.<name>.files as a source/dest pair.',
    'packaged_referenced_path_missing',
  ),
  PACKAGED_AGENT_INSTRUCTION_FILE: entry(
    'warning',
    'A repo-internal agent-instruction file (CLAUDE.md, AGENTS.md, GEMINI.md) is present in the scanned tree — a built skill bundle, an installed plugin, or a plugin source directory.',
    // Two lanes hand this detector different trees, and one remediation has to be
    // true for both. In a DIST tree the file demonstrably shipped, so removing it
    // is the fix. In a repo SOURCE tree the build already excludes it from the
    // plugin tree-copy and from files: globs, so it does not ship unless an
    // explicit files: entry names it — prescribing deletion there told adopters to
    // delete a useful repo-internal doc to silence a warning about a file that no
    // longer travels.
    //
    // The last clause is for the third lane: `vat audit <path>` resolves a subject
    // by PATH, and a built bundle's path is not its source skill's declared path,
    // so that lane cannot reach the `files:` block that may have sanctioned the
    // file. `vat build` and `vat verify` CAN, and they honour it by not reporting
    // at all — so a reader who sees this from audit alone must not conclude the
    // declaration failed.
    'In a distributed tree (a built bundle or an installed plugin) remove the file, or move it outside the directory that is packaged. In a repo source tree, confirm first whether it ships: the build excludes agent-instruction files from the plugin tree-copy and from files: globs, so only an explicit files: entry naming it puts it in the output. If it must ship, set severity.PACKAGED_AGENT_INSTRUCTION_FILE to ignore so the exception is recorded in config. If an explicit files: entry already names this dest, vat build and vat verify honour it and stay silent; vat audit reports it anyway because a path-addressed scan cannot see the config that declared it.',
    'packaged_agent_instruction_file',
  ),
  // The companion PACKAGED_AGENT_INSTRUCTION_FILE needs in order to be allowed to
  // stay silent. Its audit lane only reports files in a DISTRIBUTED tree, and the
  // distributed/source question is answered from git — so anything that stops git
  // answering (no binary on PATH, a corrupt or unreadable `.git`) used to collapse
  // to "not ignored", i.e. source, i.e. silence, with `status: success` and no
  // trace anywhere that the detector had been switched off.
  //
  // A missing answer is therefore reported as a missing answer. Deliberately NOT
  // resolved by assuming `distributed`: that manufactures a substantive claim
  // about the artifact ("this file shipped to consumers") that nothing observed,
  // and its remediation — remove the file — is wrong advice for the ordinary
  // source tree in a container with no git.
  //
  // `warning`, matching the code it stands in for, so a CI gate counting warnings
  // cannot be quietly zeroed by breaking git. Emitted only when the tree actually
  // holds agent-instruction files: with none there, nothing was left unclassified
  // and healthy git would have said nothing either.
  TREE_PROVENANCE_INDETERMINATE: entry(
    'warning',
    'Could not determine whether a scanned skill tree is repository source or a distributed artifact, because `git` could not be consulted; agent-instruction files present in the tree were left unclassified rather than silently accepted.',
    'Make `git` runnable for this tree — install it, put it on PATH, or repair the repository whose `.git` directory could not be read — then re-run the audit. Set severity.TREE_PROVENANCE_INDETERMINATE to ignore if this environment deliberately has no git and the unclassified files are known to be repository source.',
    'tree_provenance_indeterminate',
  ),
  // Same stance as TREE_PROVENANCE_INDETERMINATE above, applied to the directory
  // walk instead of to git: a missing answer is reported as a missing answer.
  //
  // `vat audit` is a bulk linter over trees it does not own — an adopter's
  // monorepo, `~/.claude/plugins`, a vendored bundle — so an entry it cannot read
  // is an ordinary condition, not an exceptional one. One root-owned or
  // quarantined directory used to abort the ENTIRE run with `status: error`, exit
  // 2, and zero findings, discarding every finding already collected from readable
  // siblings (issue #180). Degrading beats destroying: the scan continues and
  // names what it could not reach.
  //
  // Silence was the other tempting option and is not acceptable: a scan that
  // reports success while having skipped a subtree is the same failure shape as a
  // detector that silently disables itself. `warning`, not `error`, because the
  // findings that DID come back are trustworthy and an unreadable path is usually
  // an environment fact rather than a defect in the audited tree.
  SCAN_PATH_UNREADABLE: entry(
    'warning',
    'A path under the audited tree could not be read — a directory the scan could not enter, or a file it could not open — so it was not scanned; findings from every readable sibling are still reported.',
    // `--exclude` leads, and the severity override is qualified, because the
    // override is NOT reachable in the case that produces this finding most
    // often: `applySeverityFilter` early-returns unless a VAT config is found
    // above the scan path, and there is normally none above `~/.claude/plugins`.
    // Advertising a remedy an adopter cannot apply is worse than not offering it.
    'Make the path readable — check its permissions and ownership — then re-run the audit, or pass --exclude to drop it from the scan deliberately. Set severity.SCAN_PATH_UNREADABLE to ignore if the path is expected to be unreadable and the scan runs inside a project whose config VAT can find.',
    'scan_path_unreadable',
  ),
  FILES_GLOB_DROPPED_NEVER_PACKAGED: entry(
    'warning',
    'A `files:` glob matched a file that is never packaged into a skill bundle (an agent-instruction file such as CLAUDE.md, or a navigation file such as README.md); it was dropped and did not ship.',
    'No action needed if the drop is intended — a glob is a net, not a declaration. To ship that specific file deliberately, add an explicit `files:` entry naming it (`source: <path>`); to stop matching it at all, narrow the glob.',
    'files_glob_dropped_never_packaged',
  ),
  // Orthogonal to the three verdicts around it: they partition an entry by what the
  // never-package POLICY decided about its matches, this one by what the matched
  // object physically IS. `glob`'s `nodir: true` cannot catch it — glob does not
  // follow symlinks, so a symlink-to-directory is not a directory to it.
  //
  // `warning`, not `error`: the entry still ships everything else, so this is a
  // partial result rather than a failed one — the same grading logic as
  // FILES_GLOB_DROPPED_NEVER_PACKAGED. Louder than `info` because, unlike a
  // never-packaged drop, nothing about a glob's design makes catching a device node
  // the expected outcome. It replaces a raw `ENOTSUP` that killed the build naming
  // neither the entry nor the path (issue #183).
  FILES_GLOB_SKIPPED_NON_REGULAR_FILE: entry(
    'warning',
    'A `files:` glob matched something that is not a regular file (a symlink to a directory, a dangling symlink, a FIFO, a socket or a device node); it cannot be packaged and was skipped, so it did not ship.',
    'Point the glob at regular files, or narrow it so it stops matching this path. To ship the contents a directory symlink targets, name the real directory in a glob of its own (`source: <real-dir>/**/*`) — a link cannot be packaged as one file. Set severity.FILES_GLOB_SKIPPED_NON_REGULAR_FILE to ignore if the skip is expected.',
    'files_glob_skipped_non_regular_file',
  ),
  // The third of three verdicts a pre-build gate can reach about one glob entry
  // (partial drop / nothing shippable / nothing matched). This one: the glob
  // matched, and the never-package list refused EVERY match, so the entry ships
  // nothing and `copyGlobEntry` raises its own distinct error.
  //
  // A separate code rather than a widened FILES_GLOB_MATCHED_NOTHING because the
  // two have different causes and therefore different remedies: "produce the
  // artifact first" is useless advice for a glob that netted only files VAT never
  // packages, and "name the file explicitly" is useless for one whose directory
  // is empty. One code would have to carry both, and a reader would have to work
  // out which half applied to them.
  //
  // `warning`, not `error`: a pre-build tree can be a PARTIAL artifact just as it
  // can be an absent one — a stale `dist/` holding only a README.md is the same
  // phenomenon that makes the zero-match `info` — so blocking CI here can be
  // wrong. Louder than `info` because, unlike an empty directory, a directory
  // containing only never-packaged files is not the ordinary pre-build state.
  FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED: entry(
    'warning',
    'A `files:` glob matched only files that are never packaged into a skill bundle (agent-instruction files such as CLAUDE.md, navigation files such as README.md), so the entry ships nothing and `vat skills build` fails on it.',
    // Deliberately does NOT say "widen the glob": the never-package filter matches
    // on basename and applies at any width, so a wider glob clears the error while
    // still shipping none of these files — advice that looks like it worked.
    'Name the file you intend to ship in an explicit (non-glob) `files:` entry (`source: <path>`), or point the glob at a directory that holds files which can be packaged. Widening the glob does not help — the never-package filter matches on basename at any width. Set severity.FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED to ignore if the entry is deliberately inert.',
    'files_glob_matched_only_never_packaged',
  ),
  // Distinct from FILES_GLOB_DROPPED_NEVER_PACKAGED, which is about a glob that
  // MATCHED and then had a match refused, and from
  // FILES_GLOB_MATCHED_ONLY_NEVER_PACKAGED, where it matched and none survived.
  // This one is about a glob that matched nothing at all — the other input
  // `vat skills build` dies on.
  //
  // `info`, not `warning`: a pre-build gate runs before the artifact exists, so a
  // glob over an unbuilt `dist/` matching nothing is the expected state and must
  // not fail anyone's CI. But "expected state" and "the build will die on this"
  // are both true at once, and the gate used to report NEITHER — reporting the
  // drop that is harmless by design while staying silent about the zero-match
  // that is fatal.
  FILES_GLOB_MATCHED_NOTHING: entry(
    'info',
    'A `files:` glob currently matches no files; `vat skills build` fails on a glob that matches nothing, so the build will fail unless that artifact is produced first.',
    'No action needed if the glob points at a build artifact your project produces before `vat skills build` runs — matching nothing beforehand is expected. Otherwise correct the pattern (a `files:` source resolves relative to the project root) or drop the entry. Set severity.FILES_GLOB_MATCHED_NOTHING to ignore to silence it everywhere.',
    'files_glob_matched_nothing',
  ),
  PACKAGED_TEST_INPUT: entry(
    'warning',
    "A link or files: entry pointed into the skill's declared test input (its test.evals path) and was NOT packaged; test input — including the expected_output answer key — never ships to consumers.",
    'No action needed — the build already excluded it. Remove the link or files: entry to silence this, or move the target out of the test.evals directory if it is genuinely a shipped resource.',
    'packaged_test_input',
  ),
  PACKAGED_BROKEN_LINK: entry(
    'error',
    // The CAUSE deliberately lives in `fix`, not here. This code has two
    // populations — a link-rewriter bug, and a target the never-package filter
    // dropped on purpose — and only the emitting lane knows which one it is
    // holding, so only the per-issue `fix` can name it. When the cause was
    // asserted in the description ("likely a link-rewriter bug"), the
    // policy-drop branch shipped one issue whose message blamed VAT and whose
    // `fix` said "Nothing to report — VAT dropped this file on purpose": the two
    // halves of a single finding contradicting each other. The description now
    // states only what every emission observed — the link does not resolve in
    // the output — and each lane supplies its own remediation.
    'Link in the packaged output resolves to a file that is not present in the output.',
    'Report the issue — this indicates a VAT bug. As a temporary workaround, set severity.PACKAGED_BROKEN_LINK to ignore while the underlying bug is fixed.',
    'packaged_broken_link',
  ),
  FILENAME_COLLISION: entry(
    'error',
    'Two source files package to the same destination path in the bundle; one would overwrite the other.',
    "Rename one of the files, or switch resourceNaming to a path-based strategy ('resource-id' or 'preserve-path') so the sources map to distinct destinations.",
    'filename_collision',
  ),
  PLUGIN_EXCLUDE_PATTERN_UNUSED: entry(
    'warning',
    'A plugin `exclude:` pattern matched no file in the plugin source tree; it excluded nothing from the built bundle.',
    // Names only what the author can act on. A dead pattern has no "correct"
    // resolution VAT can pick — the path may be a typo, or the junk it used to
    // catch may simply be gone — so the fix is to check it against the source
    // dir and then either correct it or delete the line.
    "Check the pattern against the plugin source directory (patterns are relative to it, and a bare directory name covers its whole subtree), then correct the path — or drop the entry from the marketplace plugin entry's exclude: list if what it targeted no longer exists.",
    'plugin_exclude_pattern_unused',
  ),
  DUPLICATE_RESOURCE_ID: entry(
    'error',
    'Two files resolve to the same resource id after path normalization.',
    'Rename one of the files so they produce distinct resource ids.',
    'duplicate_resource_id',
  ),
  RESOURCE_UNREADABLE: entry(
    'error',
    'A file the crawl enumerated could not be read, so it was skipped. Most often a committed symlink whose target is missing; also permissions, or a file deleted between enumeration and parse.',
    'Repoint or delete the dangling symlink, restore the missing target, or fix the permissions. Set severity.RESOURCE_UNREADABLE to warning if a corpus is expected to contain unresolvable entries.',
    'resource_unreadable',
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
  NON_PORTABLE_ASSET_REFERENCE: entry(
    'warning',
    'A skill document (SKILL.md or a reachable bundled reference file) references a bundled script/asset via a non-portable anchor (CLAUDE_PLUGIN_ROOT). It is a Claude Code plugin-only variable that points at the plugin, not the skill, so the path breaks when the skill is mounted standalone (claude.ai upload, API container).',
    'Reference bundled files by a path relative to the skill directory (e.g. `scripts/run.mjs`), never via CLAUDE_PLUGIN_ROOT, an absolute path, or an env-var anchor. See the vibe-agent-toolkit:vat-skill-authoring skill.',
    'non_portable_asset_reference',
  ),
  NON_PORTABLE_COMMAND: entry(
    'warning',
    'A skill document (SKILL.md or a reachable bundled reference file) instructs an agent to run a shell command that hard-codes a GNU/Linux-only utility or flag (e.g. `timeout`, `grep -P`, `sed -i` with no suffix, `readlink -f`, `date -d`). These fail, or behave differently, on macOS/BSD where the agent may execute them.',
    'Use a portable equivalent: `grep -E` for PCRE, `sed -i.bak`/an explicit suffix, a temp file instead of bare `-i`, a portable resolve instead of `readlink -f`, and `date -v`/`-j -f` instead of `date -d`. Gate or avoid `timeout` (absent on macOS by default). See the vibe-agent-toolkit:vat-skill-review skill.',
    'non_portable_command',
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
    'Name the dependency in the description (e.g. "Requires ado skill for auth" or "Requires ANTHROPIC_ADMIN_API_KEY") so agents loading the skill discover it without reading the body. Allow via validation.allow with a reason when the dependency is genuinely runtime-optional.',
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
  PLUGIN_TOPLEVEL_BIN_DIR: entry(
    'warning',
    'Plugin ships a top-level `bin/` directory. `bin/` is a supported Claude Code CLI feature (its entries join the Bash tool PATH as bare commands), but a claude.ai-hosted marketplace sync has been observed to skip plugins containing it.',
    'If nothing invokes these as bare commands, move them to `scripts/` — the documented home for helper scripts — and invoke by path. Keep `bin/` only if you rely on PATH exposure and distribute via the CLI. Set severity.PLUGIN_TOPLEVEL_BIN_DIR to ignore, or add a validation.allow entry, to opt out.',
    'plugin_toplevel_bin_dir',
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
    'Add explicit markdown links from SKILL.md (or a linked file) into the bundled subdirectories, or remove the unreferenced directory. Assets consumed programmatically belong in skills.config.<name>.files as source/dest pairs — a declared dest is exempt, so do NOT restate them in validation.allow.',
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
  REGISTRY_SHAPE_DRIFT: entry(
    'info',
    "An installed-plugins registry written by Claude Code carries a field or scope value VAT's model does not recognize; the registry shape is newer than the model reading it. The value was preserved, not rejected.",
    "No action needed — VAT reads registries it does not own liberally, so the unknown value passed through untouched. Report the field so VAT's model can catch up, or set severity.REGISTRY_SHAPE_DRIFT to ignore.",
    'registry_shape_drift',
  ),

  // Resources path — link / frontmatter / external-URL codes
  // Promotions of existing resources-package validator behavior (formerly free-form
  // lowercase `type` strings). Severities are locked by the design spec and reflect
  // existing behavior. LINK_TO_GITIGNORED here is intentionally distinct from the
  // skills-packaging code LINK_TO_GITIGNORED_FILE — both coexist.
  LINK_BROKEN_FILE: entry(
    'error',
    'Local file link points to a non-existent file.',
    'Fix the path or create the target.',
    'link_broken_file',
  ),
  // The narrow companion to LINK_BROKEN_FILE: the target IS on disk, so this is
  // not a broken link on the author's machine — it is a link that resolves only
  // because macOS/Windows reconcile Unicode normalization forms and Linux does
  // not. `warning`, because it is genuinely fine where it was written and only
  // fails where the corpus is deployed or CI-checked.
  LINK_NORMALIZATION_MISMATCH: entry(
    'warning',
    'A local file link resolves only after Unicode normalization: the link text and the filename on disk are the same visible characters in different normalization forms (NFC vs NFD). It opens on macOS and Windows and fails on a byte-exact filesystem such as Linux/ext4.',
    'Make the two spellings byte-identical — rename the file on disk to its NFC form and write the link in NFC, which is the form editors and git produce. Or set severity.LINK_NORMALIZATION_MISMATCH to ignore if the corpus is only ever read on a normalization-insensitive filesystem.',
    'link_normalization_mismatch',
  ),
  LINK_BROKEN_ANCHOR: entry(
    'error',
    'Anchor link points to a non-existent heading/id.',
    'Fix the fragment or the target heading.',
    'link_broken_anchor',
  ),
  LINK_UNKNOWN: entry(
    'warning',
    'Link type could not be classified.',
    'Use a recognized link form.',
    'link_unknown',
  ),
  LINK_TO_GITIGNORED: entry(
    'error',
    'A tracked file links to a gitignored file.',
    'Link a tracked target or un-ignore it. If the target is a build artifact, declare it under skills.config.<name>.files instead.',
    'link_to_gitignored',
  ),
  LINK_UNRESOLVED_REFERENCE: entry(
    'warning',
    'A reference-style link ([text][label] or collapsed [label][]) has no matching [label]: url definition anywhere in the document.',
    'Add the missing [label]: url definition, or rewrite as an inline link [text](url).',
    'link_unresolved_reference',
  ),
  MALFORMED_HTML: entry(
    'info',
    'HTML resource has well-formedness issues reported by the parser.',
    'Fix the malformed markup (unclosed tags, stray characters). Informational by default; raise severity via validation.severity to enforce.',
    'malformed_html',
  ),
  FRONTMATTER_MISSING: entry(
    'error',
    'Schema requires frontmatter but the file has none.',
    'Add the required frontmatter.',
    'frontmatter_missing',
  ),
  FRONTMATTER_INVALID_YAML: entry(
    'error',
    'Frontmatter YAML failed to parse.',
    'Fix the YAML syntax.',
    'frontmatter_invalid_yaml',
  ),
  FRONTMATTER_SCHEMA_ERROR: entry(
    'error',
    'Frontmatter failed JSON Schema validation.',
    'Make the frontmatter conform to the schema.',
    'frontmatter_schema_error',
  ),
  FRONTMATTER_LINK_BROKEN: entry(
    'error',
    'A frontmatter URI reference points to a non-existent file.',
    'Fix the reference path.',
    'frontmatter_link_broken',
  ),
  FRONTMATTER_ANCHOR_MISSING: entry(
    'error',
    'A frontmatter URI reference points to a missing anchor.',
    'Fix the fragment.',
    'frontmatter_anchor_missing',
  ),
  FRONTMATTER_LINK_TO_GITIGNORED: entry(
    'error',
    'A frontmatter URI reference targets a gitignored file.',
    'Reference a tracked target.',
    'frontmatter_link_to_gitignored',
  ),
  FRONTMATTER_UNKNOWN_LINK: entry(
    'warning',
    'A frontmatter URI reference could not be classified.',
    'Use a recognized reference form.',
    'frontmatter_unknown_link',
  ),
  EXTERNAL_URL_DEAD: entry(
    'warning',
    'External URL returned an error status (4xx/5xx).',
    'Fix or remove the link; or set severity: ignore.',
    'external_url_dead',
  ),
  EXTERNAL_URL_TIMEOUT: entry(
    'warning',
    'External URL request timed out.',
    'Retry; raise timeout; or set severity: ignore.',
    'external_url_timeout',
  ),
  EXTERNAL_URL_ERROR: entry(
    'warning',
    'External URL validation failed (DNS/network).',
    'Check the host; or set severity: ignore.',
    'external_url_error',
  ),
  LINK_AUTH_DEAD: entry(
    'error',
    'Authenticated external link returned 404/410 from a host that gives honest 404s (notFoundMeaning: dead). Genuine link rot.',
    'Fix or remove the link; or set severity.LINK_AUTH_DEAD to ignore if the path is expected to be transient.',
    'link_auth_dead',
  ),
  LINK_AUTH_DEAD_OR_UNAUTHORIZED: entry(
    'warning',
    'Authenticated external link returned 404 from a host that masks access-denied as 404 (notFoundMeaning: ambiguous, e.g. GitHub). The link is either rotted or inaccessible to the current identity — cannot tell which.',
    'Verify the URL by hand (or with a more-privileged token) to disambiguate; fix or remove if rotted; or set severity.LINK_AUTH_DEAD_OR_UNAUTHORIZED to ignore if cross-identity ambiguity is expected.',
    'link_auth_dead_or_unauthorized',
  ),
  LINK_AUTH_FORBIDDEN: entry(
    'warning',
    'Authenticated external link returned 403: the configured identity is authenticated but lacks access to that resource. Not link rot.',
    'Grant the identity access to the resource; switch to an identity that has access; or set severity.LINK_AUTH_FORBIDDEN to ignore if cross-identity inaccessibility is expected.',
    'link_auth_forbidden',
  ),
  LINK_AUTH_UNAUTHORIZED: entry(
    'warning',
    'Authenticated external link returned 401: the configured token is missing, expired, or invalid.',
    "Refresh the token (e.g. `gh auth login`, `az login`); check the `token` config in resources.linkAuth; or promote severity.LINK_AUTH_UNAUTHORIZED to error on strict CI lanes.",
    'link_auth_unauthorized',
  ),
  LINK_AUTH_UNVERIFIED: entry(
    'warning',
    'A provider in resources.linkAuth claims this host, but no token source resolved (none of the configured env/command sources produced a value).',
    "Configure a `token` source (env var or argv command); log in to the underlying CLI (e.g. `gh auth login`, `az login`); or set severity.LINK_AUTH_UNVERIFIED to ignore if running without auth is intentional.",
    'link_auth_unverified',
  ),

  // Projection path — always-loaded context budget
  //
  // `info`, deliberately, and it is the severity that is the decision here — the
  // detector's arithmetic is not in doubt, the consequence of being wrong about
  // the THRESHOLD is.
  //
  // Three reasons, each sufficient on its own:
  //
  //  1. docs/validation-rule-design.md is explicit that new rules ship at `info`
  //     or `warning`, and that `error` requires demonstrated harm rather than
  //     disagreement with the pattern. This rule has no corpus evidence yet, so
  //     it is not entitled to the top of that ladder. (The run-integrity
  //     exemption in that same doc does not apply: VAT looked successfully and
  //     disliked what it saw, which is exactly the class the exemption excludes.)
  //  2. The number behind the code is calibrated but new. A budget is a judgement
  //     about someone else's repository, and the first version of that judgement
  //     will be wrong for somebody.
  //  3. The one production repo known to enforce an equivalent always-loaded
  //     chain budget ships THEIR chain check deliberately warn-only, having
  //     already been through this. Shipping stricter than the only prior art,
  //     with less evidence, would be a claim we cannot support.
  //
  // The failure mode being avoided is not a noisy build; it is a number that
  // fails a build being a number people learn to stop reading. `info` keeps the
  // measurement visible while it earns the right to block, and
  // validation-rule-design.md's graduation path is how it earns that.
  ALWAYS_LOADED_CONTEXT_BUDGET: entry(
    'info',
    "A working directory's always-loaded context — the repo-root CLAUDE.md, every CLAUDE.md on the directory path down to it, one level of @ imports from each, and any unscoped rules file in the root .claude/rules/ — exceeds the configured token budget. An AGENTS.md is measured only where a CLAUDE.md imports it; Claude Code does not load it by name.",
    'Raise or lower resources.validation.thresholds.alwaysLoadedContextTokens in vibe-agent-toolkit.config.yaml to move the budget, or set resources.validation.severity.ALWAYS_LOADED_CONTEXT_BUDGET to ignore to stop reporting it. Neither is usually the real fix: open the largest contributors the finding names, in the order it names them, and trim there. The win is usually in an ancestor file — a root CLAUDE.md or a root .claude/rules/ file is paid in full by every directory beneath it, so trimming one is the single edit that lowers every reported directory at once — but the finding, not the file type, says which one.',
    'always_loaded_context_budget',
  ),
} as const satisfies Record<string, CodeRegistryEntry>;

export type IssueCode = keyof typeof CODE_REGISTRY;

export const IssueCodeSchema = z.enum(
  Object.keys(CODE_REGISTRY) as [IssueCode, ...IssueCode[]],
);

/** Codes outside the overridable framework — structural reports. */
export type InfoCode =
  | 'FILE_STRUCTURE_REPORT'
  | 'RESOURCE_INVENTORY'
  | 'METADATA_SUMMARY'
  | 'SKILL_IMPLICIT_REFERENCE'
  | 'SKILL_UNREFERENCED_FILE';

/** Codes outside the overridable framework — structural prerequisites / errors that are not subject to severity overrides. */
export type NonOverridableCode =
  | 'SKILL_MISSING_FRONTMATTER'
  | 'SKILL_MISSING_NAME'
  | 'SKILL_MISSING_DESCRIPTION'
  | 'SKILL_NAME_INVALID'
  | 'SKILL_NAME_XML_TAGS'
  | 'SKILL_DESCRIPTION_XML_TAGS'
  | 'SKILL_DESCRIPTION_TOO_LONG'
  | 'SKILL_DESCRIPTION_EMPTY'
  | 'SKILL_MISCONFIGURED_LOCATION'
  | 'LINK_INTEGRITY_BROKEN'
  // 🔑 A DECLARED CHECK COULD NOT RUN — a run-integrity report, and the reason it
  // is here rather than in CODE_REGISTRY is a defect that this list makes
  // unrepresentable.
  //
  // A `vat resources check` finding carries the code `CUSTOM:<name>`, and so did
  // this one: the same code for "the check found a violation" and for "the check
  // is broken". That collision was harmless only while `CUSTOM:` keys were
  // (wrongly) unconfigurable. The moment they parse, `severity: { 'CUSTOM:foo':
  // 'ignore' }` — a documented, ordinary thing to write about a check you
  // inherited and disagree with — ALSO silences "foo could not run", and
  // `'warning'` demotes it below the exit threshold. A renamed projection column
  // would then yield exit 0 from a command whose entire purpose is to be a gate.
  //
  // So the report gets its own code, and that code is NOT overridable at all:
  // `ValidationConfigSchema` refuses it as a `severity` key, because a run whose
  // assertions did not execute has no legitimate `ignore`. Downgrade the CHECK
  // all you like; you cannot downgrade the news that it stopped checking.
  | 'RESOURCE_CHECK_BROKEN'
  | 'PATH_STYLE_WINDOWS'
  // FILENAME_COLLISION is NOT here: it has a CODE_REGISTRY entry and is emitted
  // through the same framework as every other packaging finding. Listing a code
  // in both places is a contradiction, not a belt-and-braces — `finalize()` finds
  // the registry entry and resolves severity, so the NonOverridable claim would
  // simply be false.
  | 'DUPLICATE_FILES_DEST'
  | 'PLUGIN_MISSING_MANIFEST'
  | 'PLUGIN_INVALID_JSON'
  | 'PLUGIN_INVALID_SCHEMA'
  | 'PLUGIN_MISSING_VERSION'
  | 'MARKETPLACE_MISSING_MANIFEST'
  | 'MARKETPLACE_INVALID_JSON'
  | 'MARKETPLACE_INVALID_SCHEMA'
  | 'MARKETPLACE_MISSING_LICENSE'
  | 'MARKETPLACE_MISSING_README'
  | 'MARKETPLACE_MISSING_CHANGELOG'
  | 'MARKETPLACE_MISSING_VERSION'
  | 'REGISTRY_MISSING_FILE'
  | 'REGISTRY_INVALID_JSON'
  | 'REGISTRY_INVALID_SCHEMA'
  | 'UNKNOWN_FORMAT'
  | 'SKILL_TOO_LONG'
  | 'REFERENCE_MISSING_TOC'
  | 'DESCRIPTION_FIRST_PERSON';
