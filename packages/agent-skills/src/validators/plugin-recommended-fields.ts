/**
 * Plugin manifest recommended-fields detector.
 *
 * Emits PLUGIN_MISSING_DESCRIPTION / PLUGIN_MISSING_AUTHOR / PLUGIN_MISSING_LICENSE
 * at info severity when the plugin manifest is structurally valid (passed
 * Zod schema parse) but missing fields plugin-dev names as "recommended
 * metadata". These are not schema violations — the schema makes them
 * optional — but their absence degrades discovery, attribution, and
 * redistribution clarity.
 *
 * Source guidance: anthropics/claude-plugins-official plugin-dev skill,
 * "Recommended Metadata" section.
 */

import { CODE_REGISTRY } from './code-registry.js';
import type { ValidationIssue } from './types.js';

interface PluginManifestSubset {
  description?: unknown;
  license?: unknown;
  author?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function authorHasName(author: unknown): boolean {
  if (typeof author !== 'object' || author === null) {
    return false;
  }
  const name = (author as { name?: unknown }).name;
  return isNonEmptyString(name);
}

/**
 * Inspect a parsed plugin.json object and emit one issue per missing
 * recommended field. Pass the absolute path to plugin.json as `location`.
 */
export function detectMissingRecommendedFields(
  manifest: PluginManifestSubset,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isNonEmptyString(manifest.description)) {
    const entry = CODE_REGISTRY.PLUGIN_MISSING_DESCRIPTION;
    issues.push({
      severity: entry.defaultSeverity,
      code: 'PLUGIN_MISSING_DESCRIPTION',
      message: 'plugin.json is missing the recommended `description` field.',
      location,
      fix: entry.fix,
      reference: entry.reference,
    });
  }

  if (!authorHasName(manifest.author)) {
    const entry = CODE_REGISTRY.PLUGIN_MISSING_AUTHOR;
    issues.push({
      severity: entry.defaultSeverity,
      code: 'PLUGIN_MISSING_AUTHOR',
      message: 'plugin.json is missing the recommended `author` field (with `author.name`).',
      location,
      fix: entry.fix,
      reference: entry.reference,
    });
  }

  if (!isNonEmptyString(manifest.license)) {
    const entry = CODE_REGISTRY.PLUGIN_MISSING_LICENSE;
    issues.push({
      severity: entry.defaultSeverity,
      code: 'PLUGIN_MISSING_LICENSE',
      message: 'plugin.json is missing the recommended `license` field.',
      location,
      fix: entry.fix,
      reference: entry.reference,
    });
  }

  return issues;
}
