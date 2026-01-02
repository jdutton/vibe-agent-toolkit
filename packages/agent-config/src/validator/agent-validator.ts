import fs from 'node:fs/promises';
import path from 'node:path';

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
  const ragDbPath = path.join(agentDir, '.rag-db');

  try {
    await fs.access(ragDbPath);
    // Database exists - good!
  } catch {
    errors.push(
      `RAG database not found: ${ragDbPath}. Run 'vat rag index' to create database.`
    );
  }

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
  const fullPath = path.resolve(agentDir, resourcePath);

  try {
    await fs.access(fullPath);
  } catch {
    errors.push(`Resource '${resourceId}' not found: ${resourcePath}`);
  }
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

    const resourcePath = path.resolve(agentDir, nestedResource.path as string);

    try {
      await fs.access(resourcePath);
    } catch {
      errors.push(`Resource '${resourceId}.${nestedId}' not found: ${nestedResource.path as string}`);
    }
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
    const systemPath = path.resolve(agentDir, manifest.spec.prompts.system.$ref);
    try {
      await fs.access(systemPath);
    } catch {
      errors.push(`System prompt not found: ${manifest.spec.prompts.system.$ref}`);
    }
  }

  if (manifest.spec.prompts.user) {
    const userPath = path.resolve(agentDir, manifest.spec.prompts.user.$ref);
    try {
      await fs.access(userPath);
    } catch {
      errors.push(`User prompt not found: ${manifest.spec.prompts.user.$ref}`);
    }
  }
}
