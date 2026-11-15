/**
 * What the `--compat` and `--settings` lanes of `vat audit` found, as findings.
 *
 * The lanes publish their answers as blocks on the plugin's row (`data.files[].compatibility`,
 * `.settings`). A block is not a finding: a plugin whose skill the org policy blocks was
 * `status: ok`, `findings: []`, `summary: {0, 0, 0}` beside a stderr line saying a conflict was
 * found — the human channel and the document disagreeing about one run. Each thing a lane found,
 * and each thing it could not look at, is therefore ALSO a finding on the plugin's own result, so
 * the envelope's status, the row's status and the file counts are derived from it like any other.
 *
 * Pure: it reads the rendered blocks and decides nothing about severity at run time.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';

/** A path a lane never examined, as the document renders it: root-relative, with the reason. */
interface UncheckedPath {
  readonly path: string;
  readonly reason: string;
}

/** As much of the two rendered blocks as a finding is derived from. */
export interface CompatLaneAnswer {
  /** The analyzer's block: its unchecked paths, or the reason it could not run for the plugin at all. */
  readonly compatibility: { readonly analyzed: false; readonly reason: string } | { readonly unchecked: readonly UncheckedPath[] };
  /** The settings block, present iff the run asked for `--settings`. */
  readonly settings?: {
    readonly compatible: boolean;
    readonly conflicts: ReadonlyArray<{ readonly detail: string; readonly settingsFile: string; readonly settingsLevel: string }>;
    readonly unchecked?: readonly UncheckedPath[];
  };
}

/** A finding the document already carries: as much of it as the dedupe reads. */
export interface FiledFinding {
  readonly code: string;
  readonly location: string;
}

/**
 * The codes that already SAY "this path was not read": the scan's own refusal of it, the
 * validator's refusal of its frontmatter (the settings check lists that same file as unchecked),
 * and this lane's own finding for another plugin that holds the path. Only a finding of one of
 * these at a path makes a `COMPAT_NOT_CHECKED` there a repeat — an unrelated finding that happens
 * to sit at the same location says nothing about whether the lanes read it.
 */
const SAME_REFUSAL_CODES: ReadonlySet<string> = new Set(['SCAN_PATH_UNREADABLE', 'SKILL_MISSING_FRONTMATTER', 'COMPAT_NOT_CHECKED']);

const NOT_CHECKED_FIX = 'Make the path readable and well-formed, then re-run; until then the compatibility and settings answers for this plugin do not cover it.';

function notChecked(location: string, message: string): ValidationIssue {
  return { code: 'COMPAT_NOT_CHECKED', severity: 'warning', message, location, fix: NOT_CHECKED_FIX };
}

/** Every path either lane could not examine, each once, with the first reason given for it. */
function uncheckedPaths(answer: CompatLaneAnswer): UncheckedPath[] {
  const byPath = new Map<string, UncheckedPath>();
  const all = ['unchecked' in answer.compatibility ? answer.compatibility.unchecked : [], answer.settings?.unchecked ?? []].flat();
  for (const unchecked of all) if (!byPath.has(unchecked.path)) byPath.set(unchecked.path, unchecked);
  return [...byPath.values()];
}

/**
 * The findings one plugin's lane answers amount to:
 *
 * - `SETTINGS_POLICY_CONFLICT` for each settings conflict — a tool, a hook, an MCP server or a
 *   model the plugin declares and the effective settings block — on the plugin;
 * - `COMPAT_NOT_CHECKED` when the analyzer could not run for the plugin at all, on the plugin;
 * - `COMPAT_NOT_CHECKED` for each path a lane could not examine, at that path — unless the
 *   document already carries that path's refusal ({@link SAME_REFUSAL_CODES}), or this call has
 *   just filed the plugin itself as not checked: one refused path is one finding, however many
 *   lanes met it.
 *
 * Each is a `warning`: the lanes are advisory, as `COMPAT_TARGET_INCOMPATIBLE` and the sibling
 * verb's `SETTINGS_RULE_SHADOWED` are, so they move the status and the counts and never the exit code.
 *
 * @param pluginLocation - The plugin's own row path, root-relative (`.` for the scan root)
 * @param answer - The two blocks as the document renders them
 * @param filed - Every finding the document already carries, each with the location it is published at
 * @returns The lanes' findings for this plugin, conflicts first
 */
export function compatLaneIssues(pluginLocation: string, answer: CompatLaneAnswer, filed: readonly FiledFinding[]): ValidationIssue[] {
  const refused = new Set(filed.filter((finding) => SAME_REFUSAL_CODES.has(finding.code)).map((finding) => finding.location));
  const issues: ValidationIssue[] = (answer.settings?.conflicts ?? []).map((conflict): ValidationIssue => ({
    code: 'SETTINGS_POLICY_CONFLICT',
    severity: 'warning',
    message: `${conflict.detail} — ${conflict.settingsFile} (${conflict.settingsLevel} settings).`,
    location: pluginLocation,
    fix: 'Remove what the policy blocks from the plugin, or change the settings rule the message names.',
  }));
  if ('analyzed' in answer.compatibility) {
    issues.push(notChecked(pluginLocation, `The compatibility analysis could not run for this plugin, so the run has no compatibility answer for it: ${answer.compatibility.reason}`));
    refused.add(pluginLocation);
  }
  for (const { path, reason } of uncheckedPaths(answer)) {
    if (!refused.has(path)) issues.push(notChecked(path, `The compatibility and settings checks could not examine this path, so their answers for the plugin do not cover it: ${reason}`));
  }
  return issues;
}
