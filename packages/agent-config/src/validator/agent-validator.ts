import fs from 'node:fs/promises';
import path from 'node:path';

import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';

import { loadAgentManifest, type LoadedAgentManifest } from '../loader/manifest-loader.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest: {
    name: string;
    version: string;
    path: string;
  };
}

/**
 * Validate agent manifest and check prerequisites
 * Performs:
 * - Schema validation (via loader)
 * - Tool configuration checks (RAG databases, etc.)
 * - Resource file existence checks
 */
export async function validateAgent(pathArg: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Load and validate schema
    const manifest = await loadAgentManifest(pathArg);
    const agentDir = path.dirname(manifest.__manifestPath);

    // Validate RAG configuration
    if (manifest.spec.rag) {
      await validateRAGConfig(manifest, agentDir, errors, warnings);
    }

    // Validate resource files
    if (manifest.spec.resources) {
      await validateResources(manifest, agentDir, errors, warnings);
    }

    // Validate prompt references
    if (manifest.spec.prompts) {
      await validatePrompts(manifest, agentDir, errors, warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      manifest: {
        name: manifest.metadata.name,
        version: manifest.metadata.version ?? 'unknown',
        path: manifest.__manifestPath,
      },
    };
  } catch (error) {
    // Schema validation or file loading failed
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : 'Unknown validation error'],
      warnings: [],
      manifest: {
        name: 'unknown',
        version: 'unknown',
        path: pathArg,
      },
    };
  }
}

/**
 * Push an error when `fullPath` cannot be reached.
 *
 * An absent path reports `${subject} not found`, plus `absentHint` when there
 * is a remedy to name. Any OTHER refusal — `EACCES`, `ELOOP`, a component that
 * the OS will not traverse — is reported with the OS message, because "not
 * found" would send the reader to create a file that is already there.
 */
async function requireReachable(
  fullPath: string,
  subject: string,
  shown: string,
  errors: string[],
  absentHint = ''
): Promise<void> {
  try {
    await fs.access(fullPath);
  } catch (error) {
    if (isPathAbsentError(error)) {
      errors.push(`${subject} not found: ${shown}${absentHint}`);
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    errors.push(`${subject} could not be checked: ${shown} (${reason})`);
  }
}

/**
 * Validate RAG configuration
 */
async function validateRAGConfig(
  manifest: LoadedAgentManifest,
  agentDir: string,
  errors: string[],
  warnings: string[]
): Promise<void> {
  // Check if RAG database exists
  // Default location is .rag-db in agent directory
  const ragDbPath = safePath.join(agentDir, '.rag-db');
  await requireReachable(ragDbPath, 'RAG database', ragDbPath, errors, ". Run 'vat rag index' to create database.");

  // Warn if no RAG sources defined
  if (manifest.spec.rag) {
    const ragConfigs = Object.values(manifest.spec.rag);
    const hasSources = ragConfigs.some(config => config.sources);
    if (!hasSources) {
      warnings.push('RAG configuration defined but no sources specified');
    }
  }
}

/**
 * Validate resource files exist
 */
async function validateResources(
  manifest: LoadedAgentManifest,
  agentDir: string,
  errors: string[],
  _warnings: string[]
): Promise<void> {
  if (!manifest.spec.resources) return;

  for (const [resourceId, resource] of Object.entries(manifest.spec.resources)) {
    // Resource can be either a Resource object or a nested record of Resource objects
    if ('path' in resource && typeof resource.path === 'string') {
      await validateSingleResource(agentDir, resourceId, resource.path, errors);
    } else {
      await validateNestedResources(agentDir, resourceId, resource, errors);
    }
  }
}

/**
 * Validate a single resource file
 */
async function validateSingleResource(
  agentDir: string,
  resourceId: string,
  resourcePath: string,
  errors: string[]
): Promise<void> {
  const fullPath = safePath.resolve(agentDir, resourcePath);
  await requireReachable(fullPath, `Resource '${resourceId}'`, resourcePath, errors);
}

/**
 * Validate nested resource files
 */
async function validateNestedResources(
  agentDir: string,
  resourceId: string,
  resourceRecord: Record<string, unknown>,
  errors: string[]
): Promise<void> {
  for (const [nestedId, nestedResource] of Object.entries(resourceRecord)) {
    if (typeof nestedResource !== 'object' || !nestedResource || !('path' in nestedResource)) {
      continue;
    }

    const shown = nestedResource.path as string;
    await requireReachable(safePath.resolve(agentDir, shown), `Resource '${resourceId}.${nestedId}'`, shown, errors);
  }
}

/**
 * Validate prompt files exist
 */
async function validatePrompts(
  manifest: LoadedAgentManifest,
  agentDir: string,
  errors: string[],
  _warnings: string[]
): Promise<void> {
  if (!manifest.spec.prompts) return;

  if (manifest.spec.prompts.system) {
    const ref = manifest.spec.prompts.system.$ref;
    await requireReachable(safePath.resolve(agentDir, ref), 'System prompt', ref, errors);
  }

  if (manifest.spec.prompts.user) {
    const ref = manifest.spec.prompts.user.$ref;
    await requireReachable(safePath.resolve(agentDir, ref), 'User prompt', ref, errors);
  }
}
