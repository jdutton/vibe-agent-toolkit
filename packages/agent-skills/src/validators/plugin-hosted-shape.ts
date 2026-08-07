/**
 * Plugin hosted-installability shape detector.
 *
 * Emits PLUGIN_TOPLEVEL_BIN_DIR when a plugin directory ships a non-empty
 * top-level `bin/`.
 *
 * ## What is documented vs. what is observed
 *
 * DOCUMENTED: `bin/` is a supported Claude Code plugin component. The plugins
 * reference lists it as "Executables added to the Bash tool's PATH. Files here
 * are invokable as bare commands in any Bash tool call while the plugin is
 * enabled" (shipped in Claude Code v2.1.91). It is not deprecated, and nothing
 * in Anthropic's published docs restricts it.
 *
 * DOCUMENTED: `scripts/` is the conventional home for helper scripts a plugin
 * ships — the plugin-dev skill's recognized-directory list names `scripts/`
 * and never mentions `bin/`. Helper scripts are invoked by path, not bare.
 *
 * OBSERVED (not documented): a claude.ai-hosted marketplace sync has been seen
 * to skip a plugin because it shipped a top-level `bin/`, reporting it only on
 * the org admin surface. The publish itself succeeded, so the plugin silently
 * never appeared. We have one such observation and no Anthropic source
 * confirming the rule, which is why this ships as a `warning` and the message
 * reports the observation rather than asserting a restriction.
 *
 * ## Why this is still worth flagging
 *
 * The two directories mean different things: `bin/` buys PATH exposure,
 * `scripts/` does not. A plugin whose executables are always invoked by an
 * explicit path is paying the `bin/` cost — including the observed hosted-sync
 * rejection — without using what `bin/` provides. That is worth surfacing on
 * its own, independent of whether the hosted restriction is ever documented.
 *
 * Full evidence log, and what would justify promoting this rule's severity:
 * docs/contributing/plugin-distribution-findings.md
 */

import { existsSync, readdirSync, statSync } from 'node:fs';

import { CODE_REGISTRY, type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { safePath } from '@vibe-agent-toolkit/utils';

/** How many bin/ entries to name in the message before eliding. */
const SAMPLE_LIMIT = 3;

function listBinEntries(pluginPath: string): string[] {
  const binDir = safePath.join(pluginPath, 'bin');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved under the caller-supplied plugin dir
  if (!existsSync(binDir)) return [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved under the caller-supplied plugin dir
  if (!statSync(binDir).isDirectory()) return [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved under the caller-supplied plugin dir
  return readdirSync(binDir);
}

/**
 * Inspect a plugin directory for shapes observed to break claude.ai-hosted
 * marketplace sync.
 *
 * @param pluginPath - Absolute path to the plugin directory (the one holding
 *   `.claude-plugin/`).
 */
export function detectHostedIncompatibleShape(pluginPath: string): ValidationIssue[] {
  const entries = listBinEntries(pluginPath);
  if (entries.length === 0) return [];

  const sample = entries.slice(0, SAMPLE_LIMIT).map((name) => `bin/${name}`);
  const named =
    entries.length > SAMPLE_LIMIT
      ? `${sample.join(', ')}, +${entries.length - SAMPLE_LIMIT} more`
      : sample.join(', ');

  const entry = CODE_REGISTRY.PLUGIN_TOPLEVEL_BIN_DIR;
  return [
    {
      severity: entry.defaultSeverity,
      code: 'PLUGIN_TOPLEVEL_BIN_DIR',
      message:
        `Plugin ships a top-level bin/ directory (${named}). bin/ adds these to the Bash ` +
        'tool PATH as bare commands; if they are only ever invoked by path, scripts/ is the ' +
        'documented home. A claude.ai-hosted marketplace sync has been observed to skip ' +
        'plugins containing bin/.',
      location: safePath.join(pluginPath, 'bin'),
      fix: entry.fix,
      reference: entry.reference,
    },
  ];
}
